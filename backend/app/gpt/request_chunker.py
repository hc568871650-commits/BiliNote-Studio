from dataclasses import dataclass
from typing import Callable, List, Optional
import math


@dataclass
class ChunkPayload:
    segments: list
    image_urls: list
    video_image_ranges: Optional[list] = None


class RequestChunker:
    def __init__(self, message_builder: Callable, max_bytes: int, size_estimator: Optional[Callable] = None,
                 max_text_chars: Optional[int] = None, max_duration_seconds: Optional[float] = None):
        self.message_builder = message_builder
        self.max_bytes = max_bytes
        self.size_estimator = size_estimator
        self.max_text_chars = max_text_chars
        self.max_duration_seconds = max_duration_seconds

    def _fits(self, segments, image_urls, **kwargs):
        if self.max_text_chars and sum(len(self._get_text(s)) for s in segments) > self.max_text_chars:
            return False
        if self.max_duration_seconds and len(segments) > 1:
            spans = [self._segment_range(s) for s in segments]
            if max(b for _, b in spans) - min(a for a, _ in spans) > self.max_duration_seconds:
                return False
        # An indivisible subtitle retains its true timestamps. Never invent a
        # proportional timeline when splitting its text into smaller requests.
        return self._messages_size(segments, image_urls, **kwargs) <= self.max_bytes

    def estimate(self, messages) -> int:
        if self.size_estimator:
            return self.size_estimator(messages)
        import json
        return len(json.dumps(messages, ensure_ascii=False).encode("utf-8"))

    def _messages_size(self, segments, image_urls, **kwargs) -> int:
        messages = self.message_builder(segments, image_urls, **kwargs)
        return self.estimate(messages)

    def _get_text(self, segment) -> str:
        if isinstance(segment, dict):
            return segment.get("text", "")
        return getattr(segment, "text", "")

    def _make_segment(self, segment, text: str):
        if isinstance(segment, dict):
            new_seg = dict(segment)
            new_seg["text"] = text
            return new_seg
        if hasattr(segment, "__dict__"):
            data = dict(segment.__dict__)
            data["text"] = text
            return type(segment)(**data)
        return type(segment)(segment.start, segment.end, text)

    def _split_segment_to_fit(self, segment, image_urls=(), **kwargs):
        text = self._get_text(segment)
        if not text:
            raise ValueError("empty segment cannot be split")
        lo, hi = 1, min(len(text), self.max_text_chars or len(text))
        best = None
        while lo <= hi:
            mid = (lo + hi) // 2
            candidate = self._make_segment(segment, text[:mid])
            size = self._messages_size([candidate], list(image_urls), **kwargs)
            if size <= self.max_bytes:
                best = mid
                lo = mid + 1
            else:
                hi = mid - 1
        if best is None:
            raise ValueError("single segment too large to fit request")
        head = self._make_segment(segment, text[:best])
        tail = self._make_segment(segment, text[best:])
        return head, tail

    @staticmethod
    def _segment_range(segment):
        start = float(segment['start'] if isinstance(segment, dict) else segment.start)
        end = float(segment['end'] if isinstance(segment, dict) else segment.end)
        if not math.isfinite(start) or not math.isfinite(end) or start < 0 or end < start:
            raise ValueError('字幕时间范围无效，无法对齐视频图片')
        return start, end

    @staticmethod
    def _overlaps(start, end, image_range):
        # End is exclusive for ordinary intervals; a single timestamp frame is
        # associated only with the subtitle that actually contains it.
        a, b = image_range['start'], image_range['end']
        return start <= a < end if a == b else start <= b and a < end

    def _chunk_aligned(self, segments, image_urls, image_ranges, **kwargs):
        if len(image_urls) != len(image_ranges):
            raise ValueError('视频图片与时间范围数量不一致，拒绝错配')
        ranges = []
        for value in image_ranges:
            try:
                start, end = float(value['start']), float(value['end'])
            except (TypeError, KeyError, ValueError):
                raise ValueError('视频图片时间范围无效') from None
            if not math.isfinite(start) or not math.isfinite(end) or start < 0 or end < start:
                raise ValueError('视频图片时间范围无效')
            ranges.append({'start': start, 'end': end})
        for image, bounds in zip(image_urls, ranges):
            if self._messages_size([], [image], video_image_ranges=[bounds], **kwargs) > self.max_bytes:
                raise ValueError('单张视频图片超过请求预算，无法保留视觉输入；请减少网格尺寸或提高请求预算后手动重试')
        def payload(batch):
            spans = [self._segment_range(seg) for seg in batch]
            indices = [i for i, bounds in enumerate(ranges) if any(self._overlaps(a, b, bounds) for a, b in spans)]
            return ChunkPayload(batch, [image_urls[i] for i in indices], [ranges[i] for i in indices]), indices
        def fits(chunk):
            return self._fits(chunk.segments, chunk.image_urls, video_image_ranges=chunk.video_image_ranges, **kwargs)
        chunks, batch, used = [], [], set()
        index = 0
        while index < len(segments):
            candidate, indices = payload(batch + [segments[index]])
            if fits(candidate):
                batch.append(segments[index])
                index += 1
                continue
            if batch:
                ready, indices = payload(batch)
                chunks.append(ready)
                used.update(indices)
                batch = []
                continue
            single, indices = payload([segments[index]])
            try:
                head, tail = self._split_segment_to_fit(segments[index], single.image_urls,
                    video_image_ranges=single.video_image_ranges, **kwargs)
            except ValueError:
                raise ValueError('对应字幕与视频图片无法同时放入请求预算，未降级为无图；请减少网格尺寸或提高请求预算') from None
            segments[index:index + 1] = [head, tail]
        if batch:
            ready, indices = payload(batch)
            chunks.append(ready)
            used.update(indices)
        # Frames in speech-free periods stay independent rather than being attached
        # to unrelated subtitles. Their explicit bounds travel with the payload.
        for i in range(len(image_urls)):
            if i not in used:
                chunks.append(ChunkPayload([], [image_urls[i]], [ranges[i]]))
        chunks.sort(key=lambda c: min([self._segment_range(s)[0] for s in c.segments] +
            [r['start'] for r in c.video_image_ranges or []] or [0]))
        return chunks

    def chunk(self, segments: list, image_urls: list, video_image_ranges=None, **kwargs) -> List[ChunkPayload]:
        segments = list(segments or [])
        image_urls = list(image_urls or [])
        if video_image_ranges is not None:
            return self._chunk_aligned(segments, image_urls, list(video_image_ranges), **kwargs)
        if not segments and not image_urls:
            return []

        chunks: List[ChunkPayload] = []
        seg_idx = 0

        while seg_idx < len(segments):
            batch_segments = []
            while seg_idx < len(segments):
                candidate = batch_segments + [segments[seg_idx]]
                if self._fits(candidate, [], **kwargs):
                    batch_segments = candidate
                    seg_idx += 1
                    continue
                if not batch_segments:
                    head, tail = self._split_segment_to_fit(segments[seg_idx], **kwargs)
                    segments[seg_idx] = head
                    segments.insert(seg_idx + 1, tail)
                    continue
                break

            if not batch_segments:
                raise ValueError("unable to fit any content into chunk")

            chunks.append(ChunkPayload(segments=batch_segments, image_urls=[]))

        if not image_urls:
            return chunks

        if not chunks:
            chunks = [ChunkPayload(segments=[], image_urls=[])]

        if not segments:
            for image in image_urls:
                appended = False
                for chunk in chunks[-1:]:
                    candidate_images = chunk.image_urls + [image]
                    if self._messages_size(chunk.segments, candidate_images, **kwargs) <= self.max_bytes:
                        chunk.image_urls = candidate_images
                        appended = True
                        break

                if appended:
                    continue

                if self._messages_size([], [image], **kwargs) > self.max_bytes:
                    raise ValueError("单张视频图片超过请求预算，未降级为无图")
                chunks.append(ChunkPayload(segments=[], image_urls=[image]))
            return chunks

        chunk_count = len(chunks)
        total_images = len(image_urls)
        for idx, image in enumerate(image_urls):
            preferred_idx = min(chunk_count - 1, (idx * chunk_count) // total_images)
            placed = False

            for chunk_idx in range(preferred_idx, len(chunks)):
                chunk = chunks[chunk_idx]
                candidate_images = chunk.image_urls + [image]
                if self._messages_size(chunk.segments, candidate_images, **kwargs) <= self.max_bytes:
                    chunk.image_urls = candidate_images
                    placed = True
                    break

            if placed:
                continue

            if self._messages_size([], [image], **kwargs) > self.max_bytes:
                raise ValueError("单张视频图片超过请求预算，未降级为无图")
            chunks.append(ChunkPayload(segments=[], image_urls=[image]))

        return chunks

    def group_texts_by_budget(self, texts: List[str], build_messages: Callable,
                             max_text_chars: Optional[int] = None, **kwargs) -> List[List[str]]:
        groups: List[List[str]] = []
        idx = 0
        while idx < len(texts):
            group: List[str] = []
            while idx < len(texts):
                candidate = group + [texts[idx]]
                if max_text_chars and sum(map(len, candidate)) > max_text_chars:
                    if not group:
                        # The caller can preserve this complete block without
                        # submitting it alone to a merger that cannot reduce it.
                        group = [texts[idx]]
                        idx += 1
                    break
                try:
                    messages = build_messages(candidate, [], **kwargs)
                except TypeError:
                    messages = build_messages(candidate, **kwargs)
                size = self.estimate(messages)
                if size <= self.max_bytes:
                    group = candidate
                    idx += 1
                    continue
                if not group:
                    raise ValueError("single text block exceeds max_bytes")
                break
            groups.append(group)
        return groups
