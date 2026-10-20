"""Regression tests for completion delivery and JSONL cursor continuity."""
from tests.backend import support

import asyncio
import json
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

import runner
import server
import sessions


SESSION_ID = support.SESSION_ID


class FakeSocket:
    def __init__(self, release: asyncio.Event | None = None) -> None:
        self.payloads: list[dict] = []
        self.started = asyncio.Event()
        self.release = release

    async def send_text(self, value: str) -> None:
        self.started.set()
        if self.release:
            await self.release.wait()
        self.payloads.append(json.loads(value))


async def wait_for_payloads(socket: FakeSocket, count: int) -> None:
    async with asyncio.timeout(2):
        while len(socket.payloads) < count:
            await asyncio.sleep(0.001)


class CompletionRegressionTests(support.IsolatedBackendTest):
    async def test_slow_websocket_does_not_delay_completion_notifications(self):
        hub = server.Hub()
        release = asyncio.Event()
        socket = FakeSocket(release)
        hub._subs[SESSION_ID] = {socket}
        ntfy_started = asyncio.Event()
        push_started = asyncio.Event()

        async def push_ntfy(*_args):
            ntfy_started.set()

        async def push_answer(*_args):
            push_started.set()

        run = SimpleNamespace(
            session_id=SESSION_ID, running=False, stream_id="run-1",
            exit_code=0, error=None, output="", is_aborted=False,
        )
        with patch.object(server.config, "JSONL_POLL_SEC", 0), \
                patch("server.push_ntfy", new=AsyncMock(side_effect=push_ntfy)), \
                patch.object(hub, "_push_answer", new=AsyncMock(side_effect=push_answer)):
            watching = asyncio.create_task(hub.watch_run(run))
            try:
                await asyncio.wait_for(socket.started.wait(), 1)
                await asyncio.wait_for(ntfy_started.wait(), 1)
                await asyncio.wait_for(push_started.wait(), 1)
                self.assertFalse(watching.done())
            finally:
                release.set()
                await watching




    @staticmethod
    def _line(role: str, content: str) -> bytes:
        return json.dumps({"role": role, "content": content}).encode() + b"\n"


if __name__ == "__main__":
    import unittest
    unittest.main()
