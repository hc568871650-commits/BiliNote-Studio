from typing import Literal
from fastapi import APIRouter
from pydantic import Field
from app.models.ai_requests import StrictInput
from app.services import model_capabilities as service, web_search
from app.utils.response import ResponseWrapper as R
from app.utils.ai_errors import error_details

router = APIRouter()
Protocol = Literal['openai-chat', 'openai-responses', 'anthropic']


class TestRequest(StrictInput):
    provider_id: str = Field(min_length=1, max_length=100)
    model_name: str = Field(min_length=1, max_length=200)
    protocol: Protocol = 'openai-chat'
    checks: list[str] = Field(min_length=1, max_length=10)


class SearchSettings(StrictInput):
    enabled: bool = False
    base_url: str = Field(default='', max_length=2000)
    api_key: str = Field(default='********', max_length=4000)


def call(fn, *args, **kwargs):
    try:
        return R.success(data=fn(*args, **kwargs))
    except Exception as exc:
        details = error_details(exc)
        return R.error(msg=details['detail'], data={'error_details': details})


@router.get('/model_capabilities')
def capabilities(provider_id: str, model_name: str, protocol: Protocol = 'openai-chat'):
    return call(service.get_capabilities, provider_id, model_name, protocol)


@router.post('/model_capabilities/tests')
def start(data: TestRequest):
    return call(service.start_test, **data.model_dump())


@router.get('/model_capabilities/tests/{identifier}')
def status(identifier: str):
    return call(service.get_job, identifier)


@router.post('/model_capabilities/tests/{identifier}/cancel')
def cancel(identifier: str):
    return call(service.cancel_job, identifier)


@router.get('/web_search/settings')
def search_settings():
    return call(web_search.settings)


@router.put('/web_search/settings')
def save_search_settings(data: SearchSettings):
    return call(web_search.save_settings, **data.model_dump())
