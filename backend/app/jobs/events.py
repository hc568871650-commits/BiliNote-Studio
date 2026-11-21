"""任务队列 SSE 事件总线（支持多订阅者、首包 snapshot 与心跳保活）。"""

from __future__ import annotations

import asyncio
import json
import queue
import threading
import uuid
from typing import Any, AsyncIterator, Callable


def format_sse(event: str, payload: dict[str, Any]) -> str:
    data = json.dumps(payload, ensure_ascii=False)
    return f"event: {event}\ndata: {data}\n\n"


class JobEventBus:
    """线程安全的发布/订阅事件总线。"""

    def __init__(self, max_queue_size: int = 256) -> None:
        self._max_queue_size = max_queue_size
        self._lock = threading.RLock()
        self._subscribers: dict[str, queue.Queue[tuple[str, dict[str, Any]]]] = {}

    def subscribe(self) -> tuple[str, queue.Queue[tuple[str, dict[str, Any]]]]:
        sub_id = uuid.uuid4().hex
        q: queue.Queue[tuple[str, dict[str, Any]]] = queue.Queue(maxsize=self._max_queue_size)
        with self._lock:
            self._subscribers[sub_id] = q
        return sub_id, q

    def unsubscribe(self, sub_id: str) -> None:
        with self._lock:
            self._subscribers.pop(sub_id, None)

    def publish(self, event_type: str, payload: dict[str, Any]) -> None:
        with self._lock:
            subscribers = list(self._subscribers.values())
        for q in subscribers:
            try:
                q.put_nowait((event_type, payload))
            except queue.Full:
                try:
                    q.get_nowait()
                except queue.Empty:
                    pass
                try:
                    q.put_nowait((event_type, payload))
                except queue.Full:
                    pass

    async def iter_sse(
        self,
        snapshot_provider: Callable[[], dict[str, Any]],
        *,
        once: bool = False,
        heartbeat_seconds: float = 15.0,
    ) -> AsyncIterator[str]:
        """向客户端输出 SSE 流：首包永远发送全量 snapshot，不重放历史完成事件。"""
        sub_id, q = self.subscribe()
        try:
            yield format_sse("snapshot", snapshot_provider())
            if once:
                return
            while True:
                try:
                    event_type, payload = await asyncio.to_thread(q.get, True, heartbeat_seconds)
                    yield format_sse(event_type, payload)
                except queue.Empty:
                    yield ": keepalive\n\n"
        except asyncio.CancelledError:
            return
        finally:
            self.unsubscribe(sub_id)
