"""Regression tests for MCP request ownership and media type detection."""
from tests.backend import support

import asyncio
import base64
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import config
import mcp_client
import sessions
import uploads


class FakeStdin:
    def __init__(self) -> None:
        self.writes: list[bytes] = []
        self.drain_started = asyncio.Event()

    def write(self, value: bytes) -> None:
        self.writes.append(value)

    async def drain(self) -> None:
        self.drain_started.set()
        await asyncio.Future()


def ftyp(major: bytes, *compatible: bytes) -> bytes:
    payload = major + b"\x00\x00\x00\x00" + b"".join(compatible)
    return (8 + len(payload)).to_bytes(4, "big") + b"ftyp" + payload


class TransportMediaRegressionTests(support.IsolatedBackendTest):
    async def test_cancelled_mcp_request_removes_pending_response_owner(self):
        client = mcp_client.MCPClient()
        stdin = FakeStdin()
        client._proc = SimpleNamespace(stdin=stdin, returncode=None)
        request = asyncio.create_task(client._request("tools/call", {"value": 1}, timeout=30))
        await asyncio.wait_for(stdin.drain_started.wait(), 1)

        request.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await request

        self.assertEqual(client._pending, {})
        payload = json.loads(stdin.writes[0])
        self.assertEqual(payload["method"], "tools/call")





if __name__ == "__main__":
    import unittest
    unittest.main()
