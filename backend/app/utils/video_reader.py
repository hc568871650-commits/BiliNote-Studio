import base64
import hashlib
import json
import math
import os
import re
import subprocess
from concurrent.futures import ThreadPoolExecutor, as_completed
import ffmpeg
from ffmpeg_helper import find_ffmpeg_binary
from PIL import Image, ImageDraw, ImageFont

from app.utils.logger import get_logger
from app.utils.path_helper import get_app_dir
from app.utils.dynamic_frames import scan_video, scan_plan, select_keyframes

logger = get_logger(__name__)
class VideoReader:
    def __init__(self,
                 video_path: str,
                 grid_size=(3, 3),
                 frame_interval=2,
                 dedupe_enabled=True,
                 unit_width=960,
                 unit_height=540,
                 save_quality=90,
                 font_path="fonts/arial.ttf",
                 frame_dir=None,
                 grid_dir=None,
                 frame_mode='dynamic',
                 subtitle_segments=(),
                 frame_budget=120,
                 manifest_path=None,
                 start_time=0,
                 end_time=None,
                 scan_timeout=600,
                 max_scan_samples=20000):
        self.video_path = video_path
        self.grid_size = grid_size
        self.frame_interval = frame_interval
        self.dedupe_enabled = dedupe_enabled
        self.unit_width = unit_width
        self.unit_height = unit_height
        self.save_quality = save_quality
        self.frame_dir = frame_dir or get_app_dir("output_frames")
        self.grid_dir = grid_dir or get_app_dir("grid_output")
        print(f"视频路径：{video_path}",self.frame_dir,self.grid_dir)
        self.font_path = font_path
        if frame_mode not in ('dynamic', 'fixed'):
            raise ValueError('frame_mode must be dynamic or fixed')
        self.frame_mode = frame_mode
        self.subtitle_segments = subtitle_segments
        self.frame_budget = max(1, int(frame_budget))
        self.manifest_path = manifest_path or os.path.join(os.path.dirname(self.frame_dir), 'frame_evidence.json')
        self.start_time = float(start_time)
        self.end_time = float(end_time) if end_time is not None else None
        self.evidence = []
        self.grouped_ranges = []
        self.duration = 0
        self.scan_timeout = scan_timeout
        self.max_scan_samples = max_scan_samples

    @staticmethod
    def _calculate_file_md5(file_path: str) -> str:
        hasher = hashlib.md5()
        with open(file_path, "rb") as f:
            for chunk in iter(lambda: f.read(8192), b""):
                hasher.update(chunk)
        return hasher.hexdigest()

    def format_time(self, seconds: float) -> str:
        mm = int(seconds // 60)
        ss = int(seconds % 60)
        milliseconds = int(round((seconds % 1) * 1000))
        if milliseconds == 1000:
            return self.format_time(round(seconds))
        return f"{mm:02d}_{ss:02d}_{milliseconds:03d}"

    def extract_time_from_filename(self, filename: str) -> float:
        match = re.search(r"frame_(\d+)_(\d{2})(?:_(\d{3}))?\.jpg", filename)
        if match:
            mm, ss = map(int, match.groups()[:2])
            return mm * 60 + ss + int(match.group(3) or 0) / 1000
        return float('inf')

    def _extract_single_frame(self, ts: int) -> str | None:
        """提取单帧，返回输出路径或 None（失败时）。"""
        time_label = self.format_time(ts)
        output_path = os.path.join(self.frame_dir, f"frame_{time_label}.jpg")
        # FFmpeg quantizes a fractional input seek to its stream time base.
        # One millisecond of tolerance avoids advancing a rounded source PTS.
        cmd = [find_ffmpeg_binary("ffmpeg"), "-ss", str(max(0, ts-.001)), "-i", self.video_path, "-frames:v", "1", "-q:v", "2", "-y", output_path,
               "-hide_banner", "-loglevel", "error"]
        try:
            completed = subprocess.run(cmd, capture_output=True, check=False, timeout=60)
            if completed.returncode:
                logger.warning("抽帧失败 (timestamp=%s, code=%s): %s", ts, completed.returncode,
                               completed.stderr.decode("utf-8", errors="replace")[-1000:])
                return None
            if not os.path.isfile(output_path) or os.path.getsize(output_path) == 0:
                logger.warning('抽帧未生成有效文件 (timestamp=%s)', ts)
                return None
            return output_path
        except subprocess.TimeoutExpired:
            logger.warning('单帧提取超过60秒 (timestamp=%s)', ts)
            return None
        except OSError:
            logger.exception("无法启动抽帧进程 (timestamp=%s)", ts)
            raise

    def extract_frames(self, max_frames=1000) -> list[str]:

        try:
            os.makedirs(self.frame_dir, exist_ok=True)
            if any(name.startswith('frame_') and name.endswith('.jpg') for name in os.listdir(self.frame_dir)):
                raise ValueError('Run frame directory must be empty')
            duration = self.duration = float(ffmpeg.probe(self.video_path, cmd=find_ffmpeg_binary("ffprobe"))["format"]["duration"])
            if not math.isfinite(duration) or duration <= 0:
                raise ValueError('Invalid video duration')
            start = self.start_time
            end = min(self.end_time if self.end_time is not None else duration, duration)
            if not math.isfinite(start) or not math.isfinite(end) or start < 0 or end <= start:
                raise ValueError('Invalid evidence time range')
            budget = min(max_frames, self.frame_budget)
            if budget < 1:
                raise ValueError('Frame budget must be positive')
            if self.frame_mode == 'dynamic':
                plan = scan_plan(duration, start, end, max_samples=self.max_scan_samples)
                samples = scan_video(self.video_path, duration, start_time=start, end_time=end,
                                     scan_timeout=self.scan_timeout, max_samples=self.max_scan_samples)
                # Select locally but expose the original absolute video timestamps.
                local_samples = [dict(s, time=s['time']-start) for s in samples]
                segments = [dict(text=getattr(s, 'text', '') if not isinstance(s, dict) else s.get('text', ''),
                                 start=(getattr(s, 'start', 0) if not isinstance(s, dict) else s.get('start', 0))-start,
                                 end=(getattr(s, 'end', 0) if not isinstance(s, dict) else s.get('end', 0))-start)
                            for s in self.subtitle_segments]
                self.evidence = [dict(s, time=s['time']+start)
                                 for s in select_keyframes(local_samples, end-start, budget, segments)]
            else:
                interval = max(.001, float(self.frame_interval))
                count = max(1, math.ceil((end-start)/interval))
                indices = range(count) if count <= budget else sorted({round(i*(count-1)/max(1,budget-1)) for i in range(budget)})
                self.evidence = [dict(time=round(max(start, min(start+i*interval, end-.001)), 3),
                                     reasons=['fixed_interval'], reason='fixed_interval') for i in indices]
            timestamps = [s['time'] for s in self.evidence]
            if not timestamps:
                raise ValueError('Video produced no candidate frames')

            # 并行提取帧
            max_workers = min(os.cpu_count() or 4, 2, len(timestamps))
            frame_results: dict[float, str | None] = {}
            with ThreadPoolExecutor(max_workers=max_workers) as pool:
                futures = {pool.submit(self._extract_single_frame, ts): ts for ts in timestamps}
                for future in as_completed(futures):
                    ts = futures[future]
                    frame_results[ts] = future.result()

            # 按时间戳顺序整理结果，并进行去重
            image_paths = []
            last_hash = None
            for ts in timestamps:
                output_path = frame_results.get(ts)
                if not output_path or not os.path.exists(output_path):
                    continue

                if self.dedupe_enabled:
                    frame_hash = self._calculate_file_md5(output_path)
                    if frame_hash == last_hash:
                        os.remove(output_path)
                        continue
                    last_hash = frame_hash

                image_paths.append(output_path)
            paths = {os.path.basename(p): p for p in image_paths}
            self.evidence = [dict(s, path=paths[f"frame_{self.format_time(s['time'])}.jpg"])
                             for s in self.evidence if f"frame_{self.format_time(s['time'])}.jpg" in paths]
            os.makedirs(os.path.dirname(os.path.abspath(self.manifest_path)), exist_ok=True)
            with open(self.manifest_path, 'w', encoding='utf-8') as handle:
                json.dump(dict(schema_version=1, frame_mode=self.frame_mode, duration=duration,
                               start_time=start, end_time=end, budget=budget,
                               sample_interval=plan['sample_interval'] if self.frame_mode == 'dynamic' else self.frame_interval,
                               max_scan_samples=self.max_scan_samples, scan_timeout=self.scan_timeout,
                               selected=self.evidence, failed_timestamps=[ts for ts in timestamps if not frame_results.get(ts)],
                               limitations=['Events shorter than the sampling interval may be missed', 'Selection is visual evidence, not semantic verification']),
                          handle, ensure_ascii=False, indent=2)
            if not image_paths:
                raise ValueError('No evidence frame was extracted successfully')
            return image_paths
        except Exception as e:
            logger.exception("分割帧发生错误")
            raise ValueError("视频处理失败") from e

    def group_images(self) -> list[list[str]]:
        image_files = [os.path.join(self.frame_dir, f) for f in os.listdir(self.frame_dir) if
                       f.startswith("frame_") and f.endswith(".jpg")]
        image_files.sort(key=lambda f: self.extract_time_from_filename(os.path.basename(f)))
        group_size = self.grid_size[0] * self.grid_size[1]
        return [image_files[i:i + group_size] for i in range(0, len(image_files), group_size)]

    def concat_images(self, image_paths: list[str], name: str) -> str:
        os.makedirs(self.grid_dir, exist_ok=True)
        if not image_paths:
            raise ValueError('Cannot concatenate an empty image group')
        images = []
        for path in image_paths:
            with Image.open(path) as source:
                img = source.convert('RGB')
            # unit dimensions are ceilings, never a request to upscale a source.
            img.thumbnail((self.unit_width, self.unit_height), Image.Resampling.LANCZOS)
            images.append((path, img))
        cell_width = max(img.width for _, img in images)
        cell_height = max(img.height for _, img in images)
        font_size = max(8, min(20, round(cell_height*.055)))
        if os.path.exists(self.font_path):
            font = ImageFont.truetype(self.font_path, font_size)
        else:
            try:
                font = ImageFont.load_default(size=font_size)
            except TypeError:
                font = ImageFont.load_default()
        # Caption is outside the image content, inside the bounded cell. Reserve
        # a narrow band rather than obscuring the software's parameter panels.
        caption_height = min(cell_height-1, max(10, font.getbbox('00:00.000')[3]+4))
        content_height = max(1, cell_height-caption_height)
        cells = []
        for path, img in images:
            img.thumbnail((cell_width, content_height), Image.Resampling.LANCZOS)
            cell = Image.new('RGB', (cell_width, cell_height), (20, 20, 20))
            cell.paste(img, ((cell_width-img.width)//2, (content_height-img.height)//2))
            ts = self.extract_time_from_filename(os.path.basename(path))
            time_text = f"{int(ts//60):02d}:{int(ts%60):02d}.{int(round(ts%1*1000)):03d}" if math.isfinite(ts) else ''
            draw = ImageDraw.Draw(cell)
            draw.text((3, content_height+1), time_text, fill=(255, 225, 130), font=font)
            cells.append(cell)

        cols, rows = self.grid_size
        if cols < 1 or rows < 1 or len(cells) > cols*rows:
            raise ValueError('Invalid grid capacity')
        cols = min(cols, len(cells))
        rows = min(rows, math.ceil(len(cells)/cols))
        grid_img = Image.new("RGB", (cell_width * cols, cell_height * rows), (20, 20, 20))

        for i, img in enumerate(cells):
            x = (i % cols) * cell_width
            y = (i // cols) * cell_height
            grid_img.paste(img, (x, y))

        save_path = os.path.join(self.grid_dir, f"{name}.jpg")
        grid_img.save(save_path, quality=self.save_quality)
        return save_path

    def encode_images_to_base64(self, image_paths: list[str]) -> list[str]:
        base64_images = []
        for path in image_paths:
            with open(path, "rb") as img_file:
                encoded_string = base64.b64encode(img_file.read()).decode("utf-8")
                base64_images.append(f"data:image/jpeg;base64,{encoded_string}")
        return base64_images

    def run(self)->list[str]:
        logger.info("开始提取视频帧...")
        try:
            # 确保目录存在
            print(self.frame_dir,self.grid_dir)
            os.makedirs(self.frame_dir, exist_ok=True)
            os.makedirs(self.grid_dir, exist_ok=True)
            if any(name.startswith("frame_") for name in os.listdir(self.frame_dir)) or \
               any(name.startswith("grid_") for name in os.listdir(self.grid_dir)):
                raise ValueError("Run image directory must be empty")
            self.extract_frames()
            print("2#3",self.frame_dir,self.grid_dir)
            logger.info("开始拼接网格图...")
            image_paths = []
            self.grouped_ranges = []
            groups = self.group_images()
            evidence_times = {os.path.abspath(item['path']): item['time'] for item in self.evidence}
            for idx, group in enumerate(groups, start=1):
                if len(group) < self.grid_size[0] * self.grid_size[1]:
                    logger.info("第 %s 组仅有 %s 张，保留现有画面并以空白填充", idx, len(group))
                out_path = self.concat_images(group, f"grid_{idx}")
                image_paths.append(out_path)
                times = [evidence_times[os.path.abspath(path)] for path in group]
                self.grouped_ranges.append(dict(start=min(times), end=max(times)))

            logger.info("📤 开始编码图像...")
            urls = self.encode_images_to_base64(image_paths)
            return urls
        except Exception as e:
            logger.error(f"发生错误：{str(e)}")
            raise ValueError("视频处理失败")


