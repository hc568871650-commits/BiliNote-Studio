"""Real ffmpeg synthetic fixtures, isolated from bootstrap/config/model calls."""
import importlib.util
import ast
import json
import logging
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
import uuid
from unittest.mock import patch
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


dynamic = load('dynamic_frames_isolated', 'app/utils/dynamic_frames.py')


class DynamicFrameTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        helper = types.ModuleType('ffmpeg_helper')
        helper.find_ffmpeg_binary = lambda name: shutil.which(name) or name
        logger = types.ModuleType('app.utils.logger')
        logger.get_logger = logging.getLogger
        paths = types.ModuleType('app.utils.path_helper')
        paths.get_app_dir = lambda name: str(self.root / name)
        # The fixture uses the real ffprobe CLI; no ffmpeg-python/bootstrap is needed.
        ffmpeg = types.ModuleType('ffmpeg')
        ffmpeg.probe = lambda path, cmd: json.loads(subprocess.check_output(
            [cmd, '-v', 'error', '-show_format', '-show_streams', '-of', 'json', str(path)]))
        self.modules = patch.dict(sys.modules, {'ffmpeg_helper': helper,
            'app.utils.logger': logger, 'app.utils.path_helper': paths,
            'app.utils.dynamic_frames': dynamic, 'ffmpeg': ffmpeg})
        self.modules.start()
        self.addCleanup(self.modules.stop)
        self.reader_class = load('video_reader_isolated', 'app/utils/video_reader.py').VideoReader

    def fixture(self, duration=12):
        # 10 fps; a brief menu from 2 to 3s, small parameter changes from 7 to 9s.
        frame = Image.new('RGB', (256, 144), (70, 70, 70))
        for index in range(round(duration*10)):
            image = frame.copy()
            draw = ImageDraw.Draw(image)
            ts = index/10
            if 2 <= ts < 3:
                draw.rectangle((10, 10, 85, 70), fill=(210, 210, 210))
            if 7 <= ts < 9:
                draw.rectangle((228, 16, 250, 30), fill=(240, 240, 240))
                draw.text((229, 17), '42', fill=(0, 0, 0))
            image.save(self.root / f'input_{index:04}.png')
        video = self.root / 'fixture.mp4'
        subprocess.run([shutil.which('ffmpeg'), '-hide_banner', '-loglevel', 'error', '-y',
                        '-framerate', '10', '-i', str(self.root / 'input_%04d.png'),
                        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(video)], check=True)
        return video

    def reader(self, video, mode='dynamic', **kwargs):
        folder = self.root / (mode + str(len(list(self.root.glob('dynamic*')))))
        return self.reader_class(str(video), frame_mode=mode, frame_interval=6,
                                 frame_dir=str(folder / 'frames'), grid_dir=str(folder / 'grids'), **kwargs)

    def test_real_short_menu_and_local_parameter_vs_fixed_six_seconds(self):
        video = self.fixture()
        reader = self.reader(video, subtitle_segments=[{'start': 7, 'end': 8, 'text': '修改参数数值'}])
        reader.extract_frames()
        timestamps = [s['time'] for s in reader.evidence]
        self.assertTrue(any(2 <= ts < 3 for ts in timestamps), timestamps)
        self.assertTrue(any(7 <= ts < 9 for ts in timestamps), timestamps)
        self.assertTrue(any('local_parameter_change' in s['reasons'] for s in reader.evidence))
        fixed = self.reader(video, 'fixed', dedupe_enabled=False)
        fixed.extract_frames()
        fixed_times = [s['time'] for s in fixed.evidence]
        self.assertFalse(any(2 <= ts < 3 or 7 <= ts < 9 for ts in fixed_times))
        self.assertEqual(fixed_times, [0, 6])
        # Validate selected JPEG content as well as the selector's timestamps.
        menu = next(s for s in reader.evidence if 2 <= s['time'] < 3)
        parameter = next(s for s in reader.evidence if 7 <= s['time'] < 9)
        with Image.open(menu['path']) as image:
            self.assertGreater(image.getpixel((20, 20))[0], 180)
        with Image.open(parameter['path']) as image:
            self.assertGreater(image.getpixel((248, 25))[0], 180)
        manifest = json.loads(Path(reader.manifest_path).read_text(encoding='utf-8'))
        self.assertEqual(manifest['selected'], reader.evidence)
        print('SYNTHETIC_COMPARISON', json.dumps({'dynamic': timestamps, 'fixed_6s': fixed_times}))
        artifact_dir = os.getenv('BILINOTE_DYNAMIC_TEST_ARTIFACT_DIR')
        if artifact_dir:
            target = Path(artifact_dir)
            target.mkdir(parents=True, exist_ok=True)
            shutil.copy2(video, target / 'synthetic-menu-parameter.mp4')
            report = {'dynamic': timestamps, 'fixed_6s': fixed_times,
                      'fixture_events': {'menu': [2, 3], 'parameter': [7, 9]}, 'selected': []}
            for mode, evidence in [('dynamic', reader.evidence), ('fixed', fixed.evidence)]:
                for s in evidence:
                    name = mode + '_' + Path(s['path']).name
                    shutil.copy2(s['path'], target / name)
                    report['selected'].append(dict(s, mode=mode, path=name))
            (target / 'comparison.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')

    def test_subsecond_video_and_absolute_range(self):
        tiny = self.fixture(.4)
        reader = self.reader(tiny)
        self.assertEqual(len(reader.extract_frames()), 1)
        self.assertEqual(reader.evidence[0]['time'], 0)
        video = self.fixture(12)
        local = self.reader(video, start_time=6, end_time=10, frame_budget=2)
        local.extract_frames()
        self.assertTrue(all(6 <= item['time'] < 10 for item in local.evidence))
        self.assertLessEqual(len(local.evidence), 2)

    def test_real_pts_alignment_fractional_seek_and_last_frame(self):
        # Encode each source frame as a distinctive intensity, including <1s.
        for i in range(18):
            Image.new('RGB', (256, 144), (i*10,)*3).save(self.root / f'pts_{i:04d}.png')
        video = self.root / 'pts.mp4'
        subprocess.run([shutil.which('ffmpeg'), '-hide_banner', '-loglevel', 'error', '-y',
                        '-framerate', '10', '-i', str(self.root / 'pts_%04d.png'),
                        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(video)], check=True)
        for start, end in [(0, .8), (1.2, 1.8)]:
            samples = dynamic.scan_video(video, 1.8, start_time=start, end_time=end)
            self.assertEqual([round(s['time'], 3) for s in samples], [start, start+.5])
            reader = self.reader(video, start_time=start, end_time=end)
            reader.extract_frames()
            for item in reader.evidence:
                with Image.open(item['path']) as image:
                    self.assertAlmostEqual(image.getpixel((120, 70))[0], round(item['time']*10)*10, delta=3)
        self.assertAlmostEqual(samples[-1]['time'], 1.7)
        print('PTS_ALIGNMENT', json.dumps([s['time'] for s in samples]))

    def test_real_ffmpeg_scan_without_probe_fps_metadata(self):
        video = self.fixture()
        # Actual decoding and extraction; caller receives duration but no FPS fields.
        with patch.object(sys.modules['ffmpeg'], 'probe', return_value={'format': {'duration': '12'}, 'streams': [{}]}):
            reader = self.reader(video)
            self.assertTrue(reader.extract_frames())
            self.assertTrue(any(2 <= item['time'] < 3 for item in reader.evidence))

    def test_non_grid_source_fps_pts_match_actual_jpeg(self):
        for i in range(21):
            Image.new('RGB', (256, 144), (i*10,)*3).save(self.root / f'nongrid_{i:04d}.png')
        video = self.root / 'nongrid.mp4'
        subprocess.run([shutil.which('ffmpeg'), '-hide_banner', '-loglevel', 'error', '-y',
                        '-framerate', '7', '-i', str(self.root / 'nongrid_%04d.png'),
                        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(video)], check=True)
        samples = dynamic.scan_video(video, 3, start_time=1.2, end_time=3)
        self.assertAlmostEqual(samples[0]['time'], 9/7, delta=.001)
        reader = self.reader(video)
        Path(reader.frame_dir).mkdir(parents=True)
        for item in samples:
            path = reader._extract_single_frame(item['time'])
            with Image.open(path) as image:
                self.assertAlmostEqual(image.getpixel((120, 70))[0], round(item['time']*7)*10, delta=3)
        old = subprocess.check_output([shutil.which('ffmpeg'), '-hide_banner', '-loglevel', 'error',
              '-i', str(video), '-vf', 'fps=2:round=up,scale=1:1', '-pix_fmt', 'gray', '-f', 'rawvideo', 'pipe:1'])
        # At 0.5s nominal time the 7fps source can only provide 3/7 or 4/7.
        self.assertLess(old[1], 40)
        print('NON_GRID_ALIGNMENT', json.dumps({'actual_times': [s['time'] for s in samples],
                                                'old_nominal_0.5_pixel': old[1]}))

    def test_real_scan_timeout_and_adaptive_full_range_limit(self):
        video = self.fixture(.4)
        with self.assertRaises(TimeoutError):
            dynamic.scan_video(video, .4, scan_timeout=.001)
        plan = dynamic.scan_plan(360000, max_samples=20000)
        self.assertEqual(plan['end_time'], 360000)
        self.assertEqual(plan['sample_interval'], 18)
        samples = dynamic.scan_video(video, .4, max_samples=1)
        self.assertLessEqual(len(samples), 1)

    def test_rotation_coverage_does_not_spend_full_budget_on_short_clip(self):
        samples = [dict(time=i*.5, global_change=.1, local_change=.2, fingerprint=str(i))
                   for i in range(120)]
        self.assertLessEqual(len(dynamic.select_keyframes(samples, 60, budget=120)), 3)
        # A long continuously moving video still gets only bounded coverage,
        # at most 120 and never one image per source/scanning frame.
        samples = [dict(time=i*.5, global_change=.1, local_change=.2, fingerprint=str(i))
                   for i in range(15000)]
        self.assertEqual(len(dynamic.select_keyframes(samples, 7500, budget=120)), 120)
        # Slow broadly distributed motion must not masquerade as panel changes.
        slow = [dict(time=i*.5, global_change=.01, local_change=.06,
                     changed_tile_fraction=.6, fingerprint=str(i)) for i in range(120)]
        self.assertLessEqual(len(dynamic.select_keyframes(slow, 60, budget=120)), 3)

    def test_real_continuous_rotation_uses_low_frequency_coverage(self):
        video = self.root / 'rotation.mp4'
        subprocess.run([shutil.which('ffmpeg'), '-hide_banner', '-loglevel', 'error', '-y',
                        '-f', 'lavfi', '-i', 'testsrc2=size=256x144:rate=10:duration=60',
                        '-vf', 'rotate=PI*t/4:ow=iw:oh=ih', '-c:v', 'libx264',
                        '-pix_fmt', 'yuv420p', str(video)], check=True)
        reader = self.reader(video, frame_budget=120)
        reader.extract_frames()
        self.assertLessEqual(len(reader.evidence), 3)
        self.assertGreaterEqual(reader.evidence[-1]['time'], 40)
        print('REAL_ROTATION', json.dumps({'duration': reader.duration, 'frame_budget': 120,
                                           'selected': [s['time'] for s in reader.evidence]}))

    def test_budget_spans_hour_and_rotation_is_bounded(self):
        samples = [dict(time=i*.5, global_change=.1, local_change=.2, fingerprint=str(i))
                   for i in range(15000)]
        selected = dynamic.select_keyframes(samples, 7500, budget=12)
        self.assertEqual(len(selected), 12)
        self.assertGreater(selected[-1]['time'], 6800)
        self.assertEqual([s['time'] for s in selected], sorted(s['time'] for s in selected))
        repeated = [dict(s, fingerprint='same', global_change=0, local_change=0) for s in samples]
        self.assertEqual(len(dynamic.select_keyframes(repeated, 7500, 12)), 1)

    def test_millisecond_and_hour_filename_sorting_and_bounds(self):
        reader = self.reader('unused')
        for ts in (0, .5, 59.999, 60, 6256.125, 90061.5):
            name = 'frame_' + reader.format_time(ts) + '.jpg'
            self.assertAlmostEqual(reader.extract_time_from_filename(name), ts, places=3)
        self.assertEqual(dynamic.nearest_candidate(999, [], 12), 11.999)
        self.assertEqual(dynamic.nearest_candidate(-20, [], 12), 0)
        self.assertEqual(dynamic.nearest_candidate(8, [{'time': 7.5, 'score': 5}], 12), 7.5)

    def test_grid_never_upscales_and_portrait_is_not_stretched(self):
        frames = self.root / 'source_frames'
        frames.mkdir()
        paths = []
        for i in range(4):
            path = frames / f'frame_00_0{i}_000.jpg'
            Image.new('RGB', (256, 144), (100, 100, 100)).save(path)
            paths.append(str(path))
        reader = self.reader('unused', grid_size=(2, 2))
        grid = reader.concat_images(paths, 'grid_small')
        with Image.open(grid) as image:
            self.assertEqual(image.size, (512, 288))
        portrait = frames / 'frame_00_10_000.jpg'
        Image.new('RGB', (100, 200), (240, 0, 0)).save(portrait)
        grid = reader.concat_images([str(portrait)], 'grid_portrait')
        with Image.open(grid) as image:
            self.assertEqual(image.size, (100, 200))
            red = [(x, y) for y in range(200) for x in range(100)
                   if image.getpixel((x, y))[0] > 180 and image.getpixel((x, y))[1] < 40]
            width = max(x for x, _ in red)-min(x for x, _ in red)+1
            height = max(y for _, y in red)-min(y for _, y in red)+1
            self.assertAlmostEqual(width/height, .5, delta=.03)
            self.assertLess(width, 100)
        large = frames / 'frame_00_11_000.jpg'
        Image.new('RGB', (1920, 1080)).save(large)
        grid = reader.concat_images([str(large)], 'grid_large')
        with Image.open(grid) as image:
            self.assertEqual(image.size, (960, 540))

    def test_group_ranges_match_actual_nonuniform_grid_frame_times(self):
        video = self.fixture()
        reader = self.reader(video, grid_size=(2, 1), subtitle_segments=[{'start': 7, 'end': 8, 'text': '修改参数'}])
        urls = reader.run()
        self.assertEqual(len(reader.grouped_ranges), len(urls))
        self.assertEqual(reader.grouped_ranges, [{'start': 2.0, 'end': 7.0}, {'start': 9.0, 'end': 9.0}])
        self.assertTrue(all(0 <= item['start'] <= item['end'] < reader.duration for item in reader.grouped_ranges))

    @unittest.skipUnless(os.getenv('BILINOTE_PUBLIC_TEST_VIDEO'), 'Optional public video is supplied explicitly')
    def test_public_software_video_dynamic_fixed_comparison(self):
        video = Path(os.environ['BILINOTE_PUBLIC_TEST_VIDEO']).resolve()
        analysis = Path(os.environ['BILINOTE_PUBLIC_TEST_ANALYSIS']).resolve()
        run = analysis / uuid.uuid4().hex
        run.mkdir(parents=True)
        probe = sys.modules['ffmpeg'].probe(str(video), cmd=shutil.which('ffprobe'))
        stream = next(s for s in probe['streams'] if s['codec_type'] == 'video')
        report = {'source': video.name, 'duration': float(probe['format']['duration']),
                  'source_dimensions': [stream['width'], stream['height']],
                  'has_audio': any(s['codec_type'] == 'audio' for s in probe['streams']),
                  'model_calls': 0, 'validation': 'Real video extraction; semantic menu labels unverified', 'modes': {}}
        for mode in ['dynamic', 'fixed']:
            reader = self.reader_class(str(video), frame_mode=mode, grid_size=(2, 2), frame_interval=6,
                                       dedupe_enabled=False if mode == 'fixed' else True,
                                       frame_dir=str(run / mode / 'frames'), grid_dir=str(run / mode / 'grids'),
                                       manifest_path=str(run / mode / 'frame_evidence.json'))
            reader.run()
            grids = []
            for path in Path(reader.grid_dir).glob('grid_*.jpg'):
                with Image.open(path) as image:
                    self.assertLessEqual(image.width, stream['width']*2)
                    self.assertLessEqual(image.height, stream['height']*2)
                    grids.append({'path': path.relative_to(analysis).as_posix(), 'size': list(image.size),
                                  'bytes': path.stat().st_size})
            evidence = [{key: value for key, value in s.items() if key not in ('path', 'fingerprint')}
                        | {'path': Path(s['path']).relative_to(analysis).as_posix()} for s in reader.evidence]
            self.assertEqual(len(reader.grouped_ranges), len(grids))
            report['modes'][mode] = {'frames': evidence, 'grid_images': grids, 'frame_count': len(evidence),
                                     'video_image_ranges': reader.grouped_ranges}
        (analysis / 'comparison.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        print('PUBLIC_VIDEO_COMPARISON', json.dumps({mode: data['frame_count'] for mode, data in report['modes'].items()}))

    def test_screenshot_extraction_missing_output_is_not_success(self):
        reader = self.reader('unused')
        Path(reader.frame_dir).mkdir(parents=True)
        with patch('subprocess.run', return_value=types.SimpleNamespace(returncode=0)):
            self.assertIsNone(reader._extract_single_frame(0))

    def screenshot_generator(self, screenshot):
        tree = ast.parse((ROOT / 'app/services/note.py').read_text(encoding='utf-8-sig'))
        method = next(method for node in tree.body if isinstance(node, ast.ClassDef) and node.name == 'NoteGenerator'
                      for method in node.body if isinstance(method, ast.FunctionDef) and method.name == '_insert_screenshots')
        module = ast.Module(body=[ast.ImportFrom(module='__future__', names=[ast.alias(name='annotations')], level=0), method], type_ignores=[])
        namespace = dict(Path=Path, json=json, nearest_candidate=dynamic.nearest_candidate,
                         generate_screenshot=screenshot, logger=logging.getLogger('test'),
                         extract_screenshot_timestamps=lambda _: [('Screenshot-999:00', 59940)])
        exec(compile(ast.fix_missing_locations(module), 'screenshot_method', 'exec'), namespace)
        generator = types.SimpleNamespace(run_dir=self.root / 'run', video_duration=12,
                                         frame_evidence=[{'time': 9, 'score': 5}])
        generator.run_dir.mkdir()
        return generator, namespace['_insert_screenshots']

    def test_screenshot_snaps_in_bounds_and_records_actual_time(self):
        seen = []
        def capture(video, folder, timestamp, index):
            seen.append(timestamp)
            Path(folder).mkdir(parents=True)
            output = Path(folder) / 'test.jpg'
            Image.new('RGB', (16, 16)).save(output)
            return str(output)
        generator, insert = self.screenshot_generator(capture)
        markdown = insert(generator, 'Screenshot-999:00', self.root / 'video.mp4')
        self.assertEqual(seen, [8.999])
        self.assertIn('00:09.000', markdown)
        self.assertIn('images/test.jpg', markdown)
        manifest = json.loads((generator.run_dir / 'screenshot_evidence.json').read_text(encoding='utf-8'))
        self.assertTrue(manifest[0]['success'])
        self.assertEqual(manifest[0]['actual_time'], 9)

    def test_failed_screenshot_raises_and_persists_failed_evidence(self):
        generator, insert = self.screenshot_generator(lambda *_: str(self.root / 'nonexistent.jpg'))
        with self.assertRaisesRegex(RuntimeError, 'missing or empty'):
            insert(generator, 'Screenshot-999:00', self.root / 'video.mp4')
        manifest = json.loads((generator.run_dir / 'screenshot_evidence.json').read_text(encoding='utf-8'))
        self.assertFalse(manifest[0]['success'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
