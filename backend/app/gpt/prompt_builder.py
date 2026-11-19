from app.gpt import prompt as _prompt_mod
from app.gpt.prompt import BASE_INSTRUCTIONS, SOURCE_PROMPT, LINK, SCREENSHOT

note_formats = [
    {'label': '原片定位', 'value': 'link'},
    {'label': '自动配图', 'value': 'screenshot'},
]
note_styles = [
    {'label': '教程笔记', 'value': 'tutorial'},
    {'label': '知识笔记', 'value': 'knowledge'},
]

LEGACY_STYLE_MAP = {
    'minimal': 'tutorial', 'detailed': 'tutorial', 'task_oriented': 'tutorial',
    'academic': 'knowledge', 'xiaohongshu': 'knowledge', 'life_journal': 'knowledge',
    'business': 'knowledge', 'meeting_minutes': 'knowledge',
}


def normalize_note_style(style):
    return style if style in ('tutorial', 'knowledge') else LEGACY_STYLE_MAP.get(style, 'tutorial')


def generate_base_prompt(title, segment_text, tags, _format=None, style=None, extras=None):
    # 固定规则置于动态资料前，避免标题或分片字幕截断公共前缀。
    prompt = BASE_INSTRUCTIONS
    # 旧 toc/summary 请求被安全忽略；定位默认开启，配图仍尊重原请求。
    prompt += '\n' + LINK
    if 'screenshot' in (_format or []):
        prompt += '\n' + SCREENSHOT
    prompt += '\n' + get_style_format(style)
    if extras:
        prompt += f'\n用户整理偏好（仍须遵守来源边界）：\n{extras}'
    prompt += SOURCE_PROMPT.format(video_title=title or '', segment_text=segment_text, tags=tags or '')
    return prompt


def get_style_format(style):
    if normalize_note_style(style) == 'knowledge':
        return '''知识笔记：围绕概念及其关系整理。保留定义、因果推理、作者举出的例子、适用条件、限制及原结论。
把“是什么”“为什么”“何时适用”讲清楚；只在原片有依据时写相应内容，不补造案例或理论。'''
    return '''教程笔记：围绕可复现的操作流程整理。保留操作对象、软件/版本前提、菜单路径、顺序、实际参数与单位、关键纠错及最终结果。
将作者说明的原因或限制放在对应步骤旁；有实际数值时准确记录，未提供时不要发明默认参数。
只在原片有依据时写准备、步骤、问题和结果等章节，不强凑固定模板。'''


def get_format_function(format_type):
    return {'link': LINK, 'screenshot': SCREENSHOT}.get(format_type, '')


def get_toc_format():
    return ''


def get_link_format():
    return LINK


def get_screenshot_format():
    return SCREENSHOT


def get_summary_format():
    return ''


def generate_structured_prompt(title, segment_text, tags, _format=None, style=None, extras=None):
    normalized_style = normalize_note_style(style)
    instructions = getattr(_prompt_mod, 'STRUCTURED_NOTE_INSTRUCTIONS', BASE_INSTRUCTIONS)
    prompt = instructions
    if 'screenshot' in (_format or []):
        screenshot_rules = getattr(_prompt_mod, 'STRUCTURED_SCREENSHOT_RULES', '')
        if screenshot_rules:
            prompt += '\n' + screenshot_rules
    prompt += '\n' + get_style_format(normalized_style)
    if normalized_style == 'tutorial':
        prompt += (
            '\n教程组织约束：严格保持原片实操步骤的先后顺序，确保界面与状态连贯；'
            '若后文纠正前文错误，直接采用最终正确做法并将避坑原因前置提醒或挂入 pit 详注。'
            '若原片明确交代前置环境、软件版本、依赖或权限准备，可在对应准备章节使用 checklist 块归纳自查项。'
        )
    else:
        prompt += (
            '\n知识组织约束（单/多分片通用）：主动打破视频时间流水账，按概念与逻辑体系归拢成章；'
            '若同一知识点在视频前后不同时间点被反复补充或插叙纠错，必须合并到同一个章节，'
            '并把对应多段离散原片区间按顺序列入该章节的 time_ranges（例如 [{"start":"01:10","end":"02:30"},{"start":"08:15","end":"09:00"}]）。'
            '严禁生成“来源分段 N”式标题；本篇为知识笔记，不要生成 checklist 块。'
        )
    prompt += f'\n输出 JSON 中的 note_style 字段必须为 "{normalized_style}"。'
    if extras:
        prompt += f'\n用户整理偏好（仍须遵守来源边界）：\n{extras}'
    prompt += SOURCE_PROMPT.format(video_title=title or '', segment_text=segment_text, tags=tags or '')
    return prompt


def generate_knowledge_pass1_prompt(title, segment_text, tags, _format=None, extras=None):
    prompt = getattr(_prompt_mod, 'KNOWLEDGE_ATOM_PASS1_INSTRUCTIONS', BASE_INSTRUCTIONS)
    if 'screenshot' in (_format or []):
        prompt += '\n如本片段存在关键操作或界面图解需求，请把最贴近的候选截图时间写入对应卡片的 screenshot_times。'
    if extras:
        prompt += f'\n用户整理偏好（仍须遵守来源边界）：\n{extras}'
    prompt += SOURCE_PROMPT.format(video_title=title or '', segment_text=segment_text, tags=tags or '')
    return prompt
