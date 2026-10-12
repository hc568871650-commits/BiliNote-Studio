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
