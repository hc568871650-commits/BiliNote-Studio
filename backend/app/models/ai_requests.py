"""Bounded inline-only inputs: never resolve attachment paths or URLs."""
import base64
import binascii
import re
from typing import Literal, Optional

from pydantic import BaseModel, Field, model_validator


class StrictInput(BaseModel):
    model_config = {'extra': 'forbid'}


class Attachment(StrictInput):
    type: Literal['image', 'text', 'quote']
    name: str = Field(default='', max_length=200)
    text: Optional[str] = Field(default=None, max_length=100000)
    data_url: Optional[str] = Field(default=None, max_length=7 * 1024 * 1024)

    @model_validator(mode='after')
    def validate_inline(self):
        if self.type == 'image':
            if self.text is not None or not self.data_url:
                raise ValueError('图片仅支持内联 base64 data URL')
            match = re.fullmatch(r'data:(image/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})', self.data_url)
            if not match:
                raise ValueError('图片仅支持 PNG/JPEG/WebP/GIF base64 data URL')
            try:
                raw = base64.b64decode(match[2], validate=True)
            except (ValueError, binascii.Error) as exc:
                raise ValueError('图片 base64 无效') from exc
            if not raw or len(raw) > 5 * 1024 * 1024:
                raise ValueError('单张图片不能超过 5 MiB')
            mime = match[1]
            signatures = {'image/png': raw.startswith(b'\x89PNG\r\n\x1a\n'),
                          'image/jpeg': raw.startswith(b'\xff\xd8\xff'),
                          'image/gif': raw.startswith((b'GIF87a', b'GIF89a')),
                          'image/webp': raw.startswith(b'RIFF') and raw[8:12] == b'WEBP'}
            if not signatures[mime]:
                raise ValueError('图片实际格式与 MIME 不一致')
        else:
            if not self.text or self.data_url is not None:
                raise ValueError('文本或引用附件须提供非空内联文本')
            if self.type == 'text' and not self.name.lower().endswith(('.txt', '.md', '.markdown')):
                raise ValueError('文本附件仅支持 TXT/MD')
        return self


class ChatMessage(StrictInput):
    role: Literal['user', 'assistant']
    content: str = Field(max_length=100000)
    attachments: list[Attachment] = Field(default_factory=list, max_length=8)

    @model_validator(mode='after')
    def user_attachments(self):
        if self.role != 'user' and self.attachments:
            raise ValueError('只有用户消息可以包含附件')
        return self


class AskRequest(StrictInput):
    task_id: str = Field(pattern=r'^[a-zA-Z0-9_-]{1,100}$')
    question: str = Field(min_length=1, max_length=20000)
    history: list[ChatMessage] = Field(default_factory=list, max_length=200)
    summary: str = Field(default='', max_length=12000)
    attachments: list[Attachment] = Field(default_factory=list, max_length=8)
    context_mode: Literal['note', 'selection'] = 'note'
    provider_id: str = Field(min_length=1, max_length=100)
    model_name: str = Field(min_length=1, max_length=200)
    protocol: Literal['openai-chat', 'openai-responses', 'anthropic'] = 'openai-chat'
    reasoning_effort: Literal['auto', 'none', 'low', 'medium', 'high', 'xhigh'] = 'auto'
    context_limit: Literal[272000] = 272000

    @model_validator(mode='after')
    def total_limit(self):
        attachments = self.attachments + [a for m in self.history for a in m.attachments]
        size = sum(len(a.data_url or '') * 3 // 4 if a.type == 'image' else len((a.text or '').encode('utf-8')) for a in attachments)
        if size > 12 * 1024 * 1024:
            raise ValueError('本次请求及历史附件合计不能超过 12 MiB')
        if not self.model_name.strip() or not self.provider_id.strip():
            raise ValueError('请选择供应商和模型')
        return self


class CompactRequest(StrictInput):
    task_id: str = Field(pattern=r'^[a-zA-Z0-9_-]{1,100}$')
    provider_id: str = Field(min_length=1, max_length=100)
    model_name: str = Field(min_length=1, max_length=200)
    protocol: Literal['openai-chat', 'openai-responses', 'anthropic'] = 'openai-chat'
    history: list[ChatMessage] = Field(default_factory=list, max_length=200)
    summary: str = Field(default='', max_length=12000)
    keep_recent: Literal[0, 4] = 4

    @model_validator(mode='after')
    def total_limit(self):
        AskRequest(task_id=self.task_id, provider_id=self.provider_id, model_name=self.model_name,
                   question='/compact', history=self.history, summary=self.summary, protocol=self.protocol)
        return self
