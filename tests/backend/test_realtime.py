"""Realtime authentication, request idempotency, and stream fidelity tests."""
import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from tests.backend import support

from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

import server


SESSION_ID = support.SESSION_ID


class FakeSocket:
    def __init__(self, *, fail=False):
        self.fail = fail
        self.payloads = []

    async def send_text(self, value):
        if self.fail:
            raise ConnectionError("socket closed")
        self.payloads.append(json.loads(value))


class RealtimeWebSocketTests(support.IsolatedBackendTest):
    def setUp(self):
        super().setUp()
        server._run_requests.clear()
        server.hub.clients.clear()
        server.hub._subs.clear()
        server.hub._tasks.clear()
        server.hub._stream_tasks.clear()
        server.hub._committed_assistants.clear()
        self.client = TestClient(server.app)
        self.addCleanup(self.client.close)
        self.enterContext(patch("server.log.exception"))

    async def test_unauthorized_socket_closes_with_4401_without_lifespan(self):
        with self.assertRaises(WebSocketDisconnect) as raised:
            with self.client.websocket_connect("/ws") as socket:
                socket.receive_json()

        self.assertEqual(raised.exception.code, 4401)
        self.assertEqual(server.hub.clients, set())

    async def test_bearer_header_and_signed_cookie_each_receive_hello(self):
        with patch("server.runner.running_ids", return_value=[SESSION_ID]):
            with self.client.websocket_connect(
                "/ws", headers={"authorization": f"Bearer {support.TEST_TOKEN}"}
            ) as socket:
                self.assertEqual(socket.receive_json(), {
                    "op": "hello", "running": [SESSION_ID],
                })

            self.client.cookies.set(server.COOKIE, support.TEST_TOKEN)
            with self.client.websocket_connect("/ws") as socket:
                self.assertEqual(socket.receive_json(), {
                    "op": "hello", "running": [SESSION_ID],
                })

    async def test_invalid_payload_and_subscription_positions_do_not_disconnect(self):
        subscribe = AsyncMock()
        with patch("server._require_session"), patch.object(server.hub, "subscribe", subscribe):
            with self.client.websocket_connect(
                "/ws", headers={"authorization": f"Bearer {support.TEST_TOKEN}"}
            ) as socket:
                socket.receive_json()
                socket.send_json(["not", "an", "object"])
                self.assertEqual(socket.receive_json()["message"], "Invalid message")

                socket.send_json({
                    "op": "sub", "sessionId": SESSION_ID, "fromSeq": True,
                    "requestId": "bool-cursor",
                })
                bool_error = socket.receive_json()
                socket.send_json({
                    "op": "sub", "sessionId": SESSION_ID, "fromOffset": -1,
                    "requestId": "negative-cursor",
                })
                negative_error = socket.receive_json()
                socket.send_json({"op": "unknown", "requestId": "still-open"})
                still_open = socket.receive_json()

        self.assertEqual(bool_error["message"], "Invalid subscription position")
        self.assertEqual(negative_error["message"], "Invalid subscription position")
        self.assertEqual(still_open["requestId"], "still-open")
        subscribe.assert_not_awaited()

    async def test_duplicate_run_request_starts_once_and_replays_same_receipt(self):
        run = SimpleNamespace(session_id=SESSION_ID, stream_id="run-1", error=None)
        start = AsyncMock(return_value=run)
        subscribe = AsyncMock()
        watch_run = AsyncMock()
        with patch("server.runner.start_run", new=start), \
                patch.object(server.hub, "subscribe", subscribe), \
                patch.object(server.hub, "ensure_stream"), \
                patch.object(server.hub, "watch_run", new=watch_run):
            with self.client.websocket_connect(
                "/ws", headers={"authorization": f"Bearer {support.TEST_TOKEN}"}
            ) as socket:
                socket.receive_json()
                request = {"op": "run", "requestId": "same-request", "prompt": "Hello"}
                socket.send_json(request)
                first = socket.receive_json()
                socket.send_json(request)
                second = socket.receive_json()

        self.assertEqual(first, second)
        self.assertEqual(first, {
            "op": "run.started", "requestId": "same-request",
            "sessionId": SESSION_ID, "runId": "run-1",
        })
        start.assert_awaited_once()
        subscribe.assert_awaited_once()

    async def test_invalid_websocket_start_options_never_launch_and_connection_stays_open(self):
        start = AsyncMock()
        with patch("server.runner.start_run", new=start):
            with self.client.websocket_connect(
                "/ws", headers={"authorization": f"Bearer {support.TEST_TOKEN}"}
            ) as socket:
                socket.receive_json()
                socket.send_json({
                    "op": "run", "requestId": "bad-mode", "prompt": "Hello",
                    "mode": "private",
                })
                bad_mode = socket.receive_json()
                socket.send_json({
                    "op": "run", "requestId": "bad-project", "prompt": "Hello",
                    "projectId": True,
                })
                bad_project = socket.receive_json()
                socket.send_json({"op": "unknown", "requestId": "still-open"})
                still_open = socket.receive_json()

        self.assertEqual(bad_mode["message"], "invalid conversation mode")
        self.assertEqual(bad_project["message"], "invalid project")
        self.assertEqual(still_open["requestId"], "still-open")
        start.assert_not_awaited()


class HubStreamTests(support.IsolatedBackendTest):
    async def test_incremental_delta_precedes_canonical_and_committed_delta_is_suppressed(self):
        hub = server.Hub()
        socket = FakeSocket()
        canonical_ready = asyncio.Event()

        async def tail_messages(_session_id, _offset, _seq):
            await canonical_ready.wait()
            yield {
                "role": "assistant", "seq": 3, "ts": 123,
                "responseId": "response-1", "blocks": [{"type": "text", "text": "Done"}],
            }

        async def first_stream(_run):
            yield {
                "runId": "run-1", "streamId": "stream-1", "revision": 1,
                "text": "Do", "done": False, "messageTs": 123,
                "responseId": "response-1",
            }

        await hub.subscribe(socket, SESSION_ID, 0, 0)
        with patch("server.sessions.tail_messages", new=tail_messages), \
                patch("server.runner.stream_events", new=first_stream):
            await hub.watch_stream(SimpleNamespace(session_id=SESSION_ID))
            canonical_ready.set()
            await hub._tasks[SESSION_ID]

        async def committed_stream(_run):
            yield {
                "runId": "run-1", "streamId": "stream-1", "revision": 2,
                "text": "Done", "done": True, "messageTs": 123,
                "responseId": "response-1",
            }

        with patch("server.runner.stream_events", new=committed_stream):
            await hub.watch_stream(SimpleNamespace(session_id=SESSION_ID))

        self.assertEqual([value["op"] for value in socket.payloads], ["msg.delta", "msg"])
        self.assertEqual(socket.payloads[0]["text"], "Do")
        self.assertEqual(socket.payloads[1]["message"]["blocks"][0]["text"], "Done")
        hub.unsubscribe(socket)

    async def test_reconnect_receives_latest_snapshot_without_replaying_old_queue(self):
        hub = server.Hub()
        socket = FakeSocket()
        stream_queue = asyncio.Queue()
        stream_queue.put_nowait({"revision": 1, "text": "old"})
        run = SimpleNamespace(
            session_id=SESSION_ID,
            stream_snapshot={
                "runId": "run-1", "streamId": "stream-1", "revision": 2,
                "text": "latest", "done": False,
            },
            stream_queue=stream_queue,
        )

        with patch("server.runner.get_run", return_value=run):
            await hub.send_stream_snapshot(socket, SESSION_ID)

        self.assertEqual(len(socket.payloads), 1)
        self.assertEqual(socket.payloads[0]["op"], "msg.delta")
        self.assertEqual(socket.payloads[0]["revision"], 2)
        self.assertEqual(socket.payloads[0]["text"], "latest")
        self.assertTrue(stream_queue.empty())

    async def test_broadcast_removes_dead_socket_and_cancels_unused_subscription(self):
        hub = server.Hub()
        dead = FakeSocket(fail=True)
        cancelled = asyncio.Event()

        async def wait_forever():
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()

        task = asyncio.create_task(wait_forever())
        await asyncio.sleep(0)
        hub._subs[SESSION_ID] = {dead}
        hub._tasks[SESSION_ID] = task

        await hub.broadcast(SESSION_ID, {"op": "msg"})
        await asyncio.gather(task, return_exceptions=True)

        self.assertNotIn(SESSION_ID, hub._subs)
        self.assertNotIn(SESSION_ID, hub._tasks)
        self.assertTrue(cancelled.is_set())
