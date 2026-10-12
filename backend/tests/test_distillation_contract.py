"""离线检查来源边界与历史请求兼容，不调用模型。"""
import importlib.util
import pathlib
import sys
import types
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]


def load_contract():
    package = types.ModuleType('distillation_contract')
    package.__path__ = [str(ROOT / 'app' / 'gpt')]
    # 独立模块避免其他测试的 app stubs 污染。
    sys.modules['distillation_contract'] = package
    prompt_spec = importlib.util.spec_from_file_location('app.gpt.prompt', ROOT / 'app/gpt/prompt.py')
    prompt = importlib.util.module_from_spec(prompt_spec)
    prompt_spec.loader.exec_module(prompt)
    builder_spec = importlib.util.spec_from_file_location('distillation_contract.builder', ROOT / 'app/gpt/prompt_builder.py')
    builder = importlib.util.module_from_spec(builder_spec)
    previous = sys.modules.get('app.gpt.prompt')
    sys.modules['app.gpt.prompt'] = prompt
    try:
        builder_spec.loader.exec_module(builder)
    finally:
        if previous is None:
            sys.modules.pop('app.gpt.prompt', None)
        else:
            sys.modules['app.gpt.prompt'] = previous
    return prompt, builder


PROMPT, BUILDER = load_contract()


class DistillationContractTests(unittest.TestCase):
    def test_old_requests_have_stable_semantic_migration(self):
        for style in ('minimal', 'detailed', 'task_oriented', 'tutorial', None, 'unknown'):
            self.assertEqual(BUILDER.normalize_note_style(style), 'tutorial')
        for style in ('academic', 'xiaohongshu', 'life_journal', 'business', 'meeting_minutes', 'knowledge'):
            self.assertEqual(BUILDER.normalize_note_style(style), 'knowledge')

    def test_removed_options_cannot_reintroduce_fixed_sections(self):
        old = BUILDER.generate_base_prompt('教程', '01:10 - 设置厚度为2 mm', '', ['toc', 'summary'], 'minimal')
        new = BUILDER.generate_base_prompt('教程', '01:10 - 设置厚度为2 mm', '', ['link'], 'tutorial')
        self.assertEqual(old, new)
        self.assertEqual(PROMPT.AI_SUM, '')
        self.assertIn('作者在原片作出的结论正常保留', new)
        self.assertIn('实际参数与单位', new)
        self.assertIn('不编造参数', new)

    def test_visual_and_merge_evidence_boundaries(self):
        text = BUILDER.generate_base_prompt('原片', '00:01 - 操作', '', ['screenshot'], 'knowledge')
        self.assertIn('不得声称看过画面', text)
        self.assertIn('不是视觉证据', text)
        self.assertIn('适用条件', text)
        self.assertIn('合并不是再次摘要', PROMPT.MERGE_PROMPT)
        self.assertIn('最终正确做法', PROMPT.MERGE_PROMPT)
        self.assertIn('来源时间', PROMPT.MERGE_PROMPT)

    def test_different_videos_share_all_fixed_rules_before_source(self):
        first = BUILDER.generate_base_prompt('视频甲', '00:01 - 内容甲', '标签甲',
                                            ['screenshot'], 'tutorial', '保留快捷键')
        second = BUILDER.generate_base_prompt('视频乙', '03:12 - 内容乙', '标签乙',
                                             ['screenshot'], 'tutorial', '保留快捷键')
        prefix = first.split('视频标题：', 1)[0]
        self.assertEqual(prefix, second.split('视频标题：', 1)[0])
        for rule in ('来源边界', '整理要求', '原片定位', '配图自动', '教程笔记', '保留快捷键'):
            self.assertIn(rule, prefix)
        self.assertIn('00:01 - 内容甲', first)
        self.assertNotIn('内容乙', first)
        self.assertIn('03:12 - 内容乙', second)

    def test_source_and_preferences_are_not_reformatted(self):
        text = BUILDER.generate_base_prompt('标题{title}', '00:01 - {value}', '{tag}',
                                           extras='保留 {快捷键}')
        for literal in ('标题{title}', '00:01 - {value}', '{tag}', '保留 {快捷键}'):
            self.assertEqual(text.count(literal), 1)


if __name__ == '__main__':
    unittest.main()
