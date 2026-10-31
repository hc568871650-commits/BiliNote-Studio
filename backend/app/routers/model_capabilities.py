from typing import Literal
from fastapi import APIRouter
from pydantic import Field, model_validator
from app.models.ai_requests import StrictInput
from app.services import model_capabilities as service, web_search, tavily_usage, model_context
from app.utils.response import ResponseWrapper as R
from app.utils.ai_errors import error_details

router = APIRouter()
Protocol = Literal['openai-chat', 'openai-responses', 'anthropic', 'gemini']


class TestRequest(StrictInput):
    provider_id: str = Field(min_length=1, max_length=100)
    model_name: str = Field(min_length=1, max_length=200)
    protocol: Protocol = 'openai-chat'
    checks: list[str] = Field(min_length=1, max_length=11)
    probe_stream: bool = False


class SearchSettings(StrictInput):
    provider: Literal['searxng', 'tavily'] = 'searxng'
    enabled: bool = False
    base_url: str = Field(default='', max_length=2000)
    api_key: str = Field(default='********', max_length=4000)


class SearchProfile(StrictInput):
    base_url: str = Field(default='', max_length=2000)
    api_key: str = Field(default='********', max_length=4000)


class SearchSelection(StrictInput):
    enabled: bool | None = None
    provider: Literal['searxng', 'tavily'] | None = None

    @model_validator(mode='before')
    @classmethod
    def require_changes(cls, value):
        if not value or any(item is None for item in value.values()):
            raise ValueError('请提供外部检索开关或服务，不能为 null')
        return value


class ModelContextSettings(StrictInput):
    model_window: int | None = Field(default=None, ge=8192, le=4000000, strict=True)
    user_limit: int = Field(default=272000, ge=8192, le=272000, strict=True)
    output_reserve: int = Field(default=4096, ge=512, le=65536, strict=True)


def call(fn, *args, **kwargs):
    try:
        return R.success(data=fn(*args, **kwargs))
    except Exception as exc:
        details = error_details(exc)
        return R.error(msg=details['detail'], data={'error_details': details})


@router.get('/model_capabilities')
def capabilities(provider_id: str, model_name: str, protocol: Protocol = 'openai-chat'):
    return call(service.get_capabilities, provider_id, model_name, protocol)


@router.get('/model_context/settings')
def context_settings(provider_id: str, model_name: str):
    return call(model_context.settings, provider_id, model_name)


@router.put('/model_context/settings')
def save_context_settings(provider_id: str, model_name: str, data: ModelContextSettings):
    return call(model_context.save_settings, provider_id, model_name, **data.model_dump())


@router.post('/model_capabilities/tests')
def start(data: TestRequest):
    return call(service.start_test, **data.model_dump())


@router.get('/model_capabilities/tests')
def active():
    return call(service.active_jobs)


@router.get('/model_capabilities/tests/{identifier}')
def status(identifier: str):
    return call(service.get_job, identifier)


@router.post('/model_capabilities/tests/{identifier}/cancel')
def cancel(identifier: str):
    return call(service.cancel_job, identifier)


@router.get('/web_search/settings')
def search_settings():
    return call(web_search.settings)


@router.get('/web_search/tavily/usage')
def search_tavily_usage(refresh: bool = False):
    return call(tavily_usage.get_usage, refresh=refresh)


@router.put('/web_search/settings')
def save_search_settings(data: SearchSettings):
    return call(web_search.save_settings, **data.model_dump())


@router.put('/web_search/profiles/{provider}')
def save_search_profile(provider: Literal['searxng', 'tavily'], data: SearchProfile):
    return call(web_search.save_profile, provider, **data.model_dump())


@router.put('/web_search/selection')
def save_search_selection(data: SearchSelection):
    return call(web_search.save_selection, **data.model_dump(exclude_unset=True))
