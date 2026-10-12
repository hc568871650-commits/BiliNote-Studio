"""Bounded, local video evidence selection; no model or network dependency."""
import math
import re
import hashlib
import subprocess
import tempfile
import threading
from PIL import Image, ImageChops, ImageStat

OPERATION = re.compile(r"点击|菜单|参数|设置|调整|输入|修改|选择|打开|数值|click|menu|parameter|change|set\b", re.I)


def frame_metrics(previous, current):
    """Global/local changes plus their spatial extent, normalized to [0,1]."""
    diff = ImageChops.difference(previous, current)
    global_change = ImageStat.Stat(diff).mean[0] / 255
    w, h = diff.size
    tiles = [ImageStat.Stat(diff.crop((x*w//8, y*h//6, (x+1)*w//8,
                                      (y+1)*h//6))).mean[0] / 255
             for y in range(6) for x in range(8)]
    return global_change, max(tiles), sum(value >= .015 for value in tiles)/len(tiles)


def frame_difference(previous, current):
    """Global and maximum local tile differences, normalized to [0,1]."""
    return frame_metrics(previous, current)[:2]


def scan_plan(duration, start_time=0, end_time=None, sample_fps=2, max_samples=20000):
    """Full-range bounded measurements; long videos trade sampling detail for memory."""
    end = min(duration, end_time if end_time is not None else duration)
    span = end-start_time
    if not all(math.isfinite(v) for v in (duration, start_time, end, sample_fps)) or span <= 0 or start_time < 0 or sample_fps <= 0 or max_samples < 1:
        raise ValueError('Invalid video scan range or sampling limit')
    return dict(start_time=start_time, end_time=end, sample_interval=max(1/sample_fps, span/max_samples),
                max_samples=max_samples, requested_fps=sample_fps)


def scan_video(video_path, duration, sample_fps=2, start_time=0, end_time=None,
               max_samples=20000, scan_timeout=600):
    """Decode once with real source PTS, limited measurements and wall-clock time."""
    from ffmpeg_helper import find_ffmpeg_binary
    plan = scan_plan(duration, start_time, end_time, sample_fps, max_samples)
    if not math.isfinite(scan_timeout) or scan_timeout <= 0:
        raise ValueError('Invalid scan timeout')
    # fps synthesizes a clock and may choose a later source frame. select retains
    # actual source PTS, including VFR streams and a fractional seek start.
    interval = plan['sample_interval']
    cmd = [find_ffmpeg_binary('ffmpeg'), '-hide_banner', '-loglevel', 'info', '-nostats',
           '-ss', str(start_time), '-i', str(video_path),
           '-t', str(plan['end_time']-start_time),
           '-vf', f"select='isnan(prev_selected_t)+gte(t-prev_selected_t,{interval})',scale=256:144,format=gray,showinfo",
           '-fps_mode', 'passthrough',
           '-pix_fmt', 'gray', '-f', 'rawvideo', '-threads', '1', 'pipe:1']
    samples, previous = [], None
    with tempfile.TemporaryFile() as errors:
        process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=errors)
        expired = threading.Event()
        def timeout():
            expired.set()
            try:
                process.kill()
            except OSError:
                pass
        watchdog = threading.Timer(scan_timeout, timeout)
        watchdog.daemon = True
        watchdog.start()
        try:
            while True:
                raw = process.stdout.read(256 * 144)
                if not raw:
                    break
                if len(raw) != 256 * 144:
                    raise ValueError('Incomplete scan frame')
                image = Image.frombytes('L', (256, 144), raw)
                global_change, local, extent = frame_metrics(previous, image) if previous else (0, 0, 0)
                # Exact thumbnail hashes reject static duplicates while retaining small UI changes.
                if len(samples) >= max_samples:
                    raise RuntimeError('Video scan exceeded its measurement limit')
                samples.append(dict(global_change=global_change, local_change=local, changed_tile_fraction=extent,
                                    fingerprint=hashlib.sha256(raw).hexdigest()))
                previous = image
            code = process.wait()
            if expired.is_set():
                raise TimeoutError(f'Video evidence scan exceeded {scan_timeout}s; no partial evidence was accepted')
            if code:
                errors.seek(0)
                raise RuntimeError(errors.read().decode('utf-8', 'replace')[-1000:])
            errors.seek(0)
            timestamps = []
            for line in errors:
                match = re.search(rb'\bn:\s*\d+.*?\bpts_time:([^\s]+)', line)
                if match:
                    timestamps.append(float(match.group(1)))
            if len(timestamps) < len(samples):
                raise RuntimeError('Video scan source timestamps are missing')
            for sample, ts in zip(samples, timestamps):
                sample['time'] = start_time+ts
            samples = [s for s in samples if start_time <= s['time'] < plan['end_time']]
        finally:
            watchdog.cancel()
            process.stdout.close()
            if process.poll() is None:
                process.kill()
                process.wait()
    return samples


def select_keyframes(samples, duration, budget=120, subtitle_segments=()):
    """Pure selector for full videos or local re-distillation ranges.

    Each sample is {time, global_change, local_change, fingerprint}. At most
    budget unique frames are returned, with time/reasons/score measurements.
    Equal temporal buckets reserve coverage even when motion persists early.
    """
    if not math.isfinite(duration) or duration <= 0 or budget < 1:
        return []
    samples = sorted((dict(s) for s in samples if 0 <= s['time'] < duration), key=lambda s: s['time'])
    cues = []
    for seg in subtitle_segments:
        text = seg.get('text', '') if isinstance(seg, dict) else getattr(seg, 'text', '')
        start = seg.get('start', 0) if isinstance(seg, dict) else getattr(seg, 'start', 0)
        end = seg.get('end', start) if isinstance(seg, dict) else getattr(seg, 'end', start)
        if OPERATION.search(text):
            cues.append((start, end))
    # Merge operation windows once instead of an O(frames * subtitles) scan.
    merged = []
    for a, b in sorted((a-.5, b+1) for a, b in cues):
        if merged and a <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], b))
        else:
            merged.append((a, b))
    cue_index = 0
    events = []
    for i, s in enumerate(samples):
        after = samples[i+1] if i+1 < len(samples) else s
        stable = (after['global_change'] < .015 and after['local_change'] < .08
                  and after.get('changed_tile_fraction', 0) <= .25)
        local_event = (s['local_change'] >= .045 and s['global_change'] < .08
                       and s.get('changed_tile_fraction', 0) <= .25)
        changed = s['global_change'] >= .025 or local_event
        while cue_index < len(merged) and merged[cue_index][1] < s['time']:
            cue_index += 1
        cue = cue_index < len(merged) and merged[cue_index][0] <= s['time'] <= merged[cue_index][1]
        reasons = ['coverage']
        if changed:
            reasons.append('local_parameter_change' if local_event else 'scene_change')
        if stable:
            reasons.append('stable_frame')
        if cue:
            reasons.append('subtitle_operation')
        score = (5 if changed and stable else .5 if changed else 0) + (2 if cue else 0) + (1 if stable else 0)
        events.append(dict(s, reasons=reasons, reason=', '.join(reasons), score=score))
    # One representative per bucket first; this limits spinning camera capture.
    buckets = min(budget, max(1, math.ceil(duration / 20)))
    groups = [[] for _ in range(buckets)]
    for s in events:
        groups[min(buckets-1, int(s['time']/duration*buckets))].append(s)
    chosen, seen = [], set()
    def add(s):
        fingerprint = s.get('fingerprint', str(s['time']))
        if fingerprint in seen:
            return False
        seen.add(fingerprint)
        chosen.append(s)
        return True
    for group in groups:
        for s in sorted(group, key=lambda s: (-s['score'], s['time'])):
            if add(s):
                break
    # Spend remaining budget on distinct stable transitions / subtitle operations.
    for s in sorted(events, key=lambda s: (-s['score'], s['time'])):
        if len(chosen) >= budget:
            break
        if s['score'] >= 3 and all(abs(s['time']-c['time']) >= .75 for c in chosen):
            add(s)
    return sorted(chosen, key=lambda s: s['time'])


def nearest_candidate(timestamp, candidates, duration, max_distance=8):
    """Clamp to media bounds, snap only to a nearby selected evidence frame."""
    target = min(max(0, float(timestamp)), max(0, duration-.001))
    valid = [c for c in candidates if 0 <= c['time'] < duration]
    if valid:
        nearest = min(valid, key=lambda c: (abs(c['time']-target), -c.get('score', 0)))
        if abs(nearest['time']-target) <= max_distance:
            return nearest['time']
    return target
