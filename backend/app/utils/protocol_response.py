"""Response-shape checks: retain transport metadata, never echo response bodies."""
import json
from app.utils.ai_errors import ResponseFormatError


def format_kind(value):
    if isinstance(value, bytes):
        value = value[:128].decode('utf-8', errors='replace')
    if not isinstance(value, str):
        return 'object'
    text = value.lstrip()[:128].lower()
    if text.startswith(('data:', 'event:', ':')):
        return 'sse'
    if text.startswith(('<!doctype', '<html', '<')):
        return 'html'
    if text.startswith(('{', '[')):
        return 'invalid-json'
    return 'text'


def response_metadata(response):
    headers = getattr(response, 'headers', {})
    return {'request_id': headers.get('x-request-id') or headers.get('request-id'),
            'status_code': getattr(response, 'status_code', None)}


def json_response(response):
    try:
        data = response.json()
    except (ValueError, UnicodeError):
        raise ResponseFormatError('json', format_kind(response.content), **response_metadata(response)) from None
    if not isinstance(data, dict):
        raise ResponseFormatError('object', 'object', **response_metadata(response))
    return data


def require_sse(response):
    if response is None:
        return
    content_type = response.headers.get('content-type', '').split(';', 1)[0].strip().lower()
    # Some compatible relays omit the SSE header. Still require real frames and
    # a completion marker downstream; do not reject a working stream by header alone.
    if content_type in ('', 'text/plain', 'application/octet-stream'):
        return
    if content_type != 'text/event-stream':
        actual = 'json' if content_type.endswith('/json') or content_type.endswith('+json') else 'html' if content_type == 'text/html' else 'text'
        raise ResponseFormatError('sse', actual, **response_metadata(response))


def event_json(text, response):
    try:
        data = json.loads(text)
    except (ValueError, UnicodeError):
        raise ResponseFormatError('sse-json', 'invalid-json', **response_metadata(response)) from None
    if not isinstance(data, dict):
        raise ResponseFormatError('sse-json', 'object', **response_metadata(response))
    return data


def validate_chat_response(response):
    if not isinstance(getattr(response, 'choices', None), list):
        raise ResponseFormatError('chat-completion', format_kind(response), request_id=getattr(response, '_request_id', None))
    for choice in response.choices:
        if getattr(choice, 'message', None) is None:
            raise ResponseFormatError('chat-completion', 'object', request_id=getattr(response, '_request_id', None))
    return response
