"""Synthetic Chat Completions stream for offline fixtures and regression tests."""
def as_stream(response):
    class Stream:
        def __iter__(self):
            choice = response.choices[0]
            message = choice.message
            content = getattr(message, 'content', None) or ''
            for offset in range(0, len(content), 12):
                yield {'choices': [{'index': 0, 'delta': {'content': content[offset:offset + 12]}}]}
            calls = getattr(message, 'tool_calls', None) or []
            if calls:
                yield {'choices': [{'index': 0, 'delta': {'tool_calls': [
                    {'index': index, 'id': call.id, 'function': {'name': call.function.name,
                      'arguments': call.function.arguments}} for index, call in enumerate(calls)]}}]}
            yield {'choices': [{'index': 0, 'delta': {}, 'finish_reason': getattr(choice, 'finish_reason', None) or 'stop'}]}

        def close(self):
            pass

    return Stream()


def streaming_fixture(create):
    def wrapped(**kwargs):
        response = create(**kwargs)
        return as_stream(response) if kwargs.get('stream') else response
    return wrapped
