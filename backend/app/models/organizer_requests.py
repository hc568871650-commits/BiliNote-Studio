from typing import Literal, Optional

from pydantic import Field, model_validator
from app.models.ai_requests import StrictInput


class OrganizerScope(StrictInput):
    kind: Literal['all', 'folder', 'selected'] = 'all'
    folder_id: Optional[str] = None
    task_ids: list[str] = Field(default_factory=list, max_length=500)

    @model_validator(mode='after')
    def consistent(self):
        if self.kind == 'folder' and not self.folder_id:
            raise ValueError('请选择文件夹')
        if self.kind == 'selected' and not self.task_ids:
            raise ValueError('请选择笔记')
        if self.kind != 'folder' and self.folder_id is not None:
            raise ValueError('当前范围不支持 folder_id')
        if self.kind != 'selected' and self.task_ids:
            raise ValueError('当前范围不支持 task_ids')
        return self


class PlanRequest(StrictInput):
    instruction: str = Field(min_length=1, max_length=4000)
    scope: OrganizerScope = Field(default_factory=OrganizerScope)
    provider_id: str = Field(min_length=1, max_length=100)
    model_name: str = Field(min_length=1, max_length=200)
    protocol: Literal['openai-chat', 'openai-responses', 'anthropic'] = 'openai-chat'
    reasoning_effort: Literal['auto', 'none', 'low', 'medium', 'high', 'xhigh', 'max'] = 'auto'
    web_search: bool = False
    web_search_mode: Literal['native', 'external'] = 'native'
    context_limit: Literal[272000] = 272000


class PlanActionRequest(StrictInput):
    plan_id: str = Field(pattern=r'^[a-f0-9]{32}$')


class SessionCreateRequest(StrictInput):
    scope: OrganizerScope = Field(default_factory=OrganizerScope)
    provider_id: Optional[str] = Field(default=None, max_length=100)
    model_name: Optional[str] = Field(default=None, max_length=200)
    protocol: Literal['openai-chat', 'openai-responses', 'anthropic'] = 'openai-chat'
    confirmation_token: Optional[str] = Field(default=None, pattern=r'^[a-f0-9]{64}$')
    request_id: Optional[str] = Field(default=None, min_length=1, max_length=100)


class RetentionPreviewRequest(StrictInput):
    operation: Literal['create', 'set_limit']
    limit: Optional[int] = Field(default=None, ge=1, le=100, strict=True)


class RetentionUpdateRequest(StrictInput):
    limit: int = Field(ge=1, le=100, strict=True)
    confirmation_token: Optional[str] = Field(default=None, pattern=r'^[a-f0-9]{64}$')
    request_id: Optional[str] = Field(default=None, min_length=1, max_length=100)


class SessionMessageRequest(PlanRequest):
    request_id: str = Field(min_length=1, max_length=100)
    expected_revision: int = Field(ge=0)


class SessionActionRequest(StrictInput):
    expected_revision: int = Field(ge=0)
    request_id: str = Field(min_length=1, max_length=100)
    plan_id: Optional[str] = Field(default=None, pattern=r'^[a-f0-9]{32}$')


class SessionCompactRequest(StrictInput):
    expected_revision: int = Field(ge=0)
    request_id: str = Field(min_length=1, max_length=100)
    provider_id: str = Field(min_length=1, max_length=100)
    model_name: str = Field(min_length=1, max_length=200)
    protocol: Literal['openai-chat', 'openai-responses', 'anthropic'] = 'openai-chat'
