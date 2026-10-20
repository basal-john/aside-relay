"""Regression coverage for browser preview cache publication."""
from tests.backend import support

import threading
from pathlib import Path
from unittest.mock import AsyncMock, patch

import browser
import server


class _StagedTemporaryFile:
    def __init__(self, path: Path, half_written: threading.Event, finish_write: threading.Event) -> None:
        self.name = str(path)
        self._file = path.open("wb")
        self._half_written = half_written
        self._finish_write = finish_write

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        self._file.close()

    def write(self, data: bytes) -> int:
        midpoint = len(data) // 2
        self._file.write(data[:midpoint])
        self._file.flush()
        self._half_written.set()
        if not self._finish_write.wait(timeout=2):
            raise TimeoutError("cache reader did not inspect the destination")
        self._file.write(data[midpoint:])
        return len(data)


class BrowserPreviewRegressionTests(support.IsolatedBackendTest):
    async def test_finite_shot_response_keeps_headers_and_body_from_one_frame(self):
        old_frame = b"\xff\xd8\xffold-frame\xff\xd9"
        new_frame = b"\xff\xd8\xffnew-frame" + b"x" * 4096 + b"\xff\xd9"
        destination = self.root / "preview.jpg"
        replacement = self.root / "replacement.jpg"
        destination.write_bytes(old_frame)
        replacement.write_bytes(new_frame)
        sent: list[dict] = []

        with patch(
            "server.browser.screenshot",
            new=AsyncMock(return_value=(destination, {"cached": True})),
        ):
            response = await server.api_tab_shot(
                "tab-response", full=False, q=62, fresh=False, session=None, all=False
            )

        async def receive() -> dict:
            return {"type": "http.request", "body": b"", "more_body": False}

        async def send(message: dict) -> None:
            sent.append(message)
            if message["type"] == "http.response.start":
                replacement.replace(destination)

        await response(
            {
                "type": "http",
                "method": "GET",
                "path": "/api/tabs/tab-response/shot",
                "headers": [],
            },
            receive,
            send,
        )
        start = next(message for message in sent if message["type"] == "http.response.start")
        body = b"".join(
            message.get("body", b"")
            for message in sent
            if message["type"] == "http.response.body"
        )
        headers = dict(start["headers"])

        self.assertEqual(int(headers[b"content-length"]), len(body))
        self.assertEqual(body, old_frame)
        self.assertTrue(body.endswith(b"\xff\xd9"))
        self.assertEqual(headers[b"content-type"], b"image/jpeg")
        self.assertEqual(headers[b"cache-control"], b"no-cache")

    async def test_reader_sees_complete_old_frame_until_new_frame_is_published(self):
        old_frame = b"\xff\xd8\xffold-frame\xff\xd9"
        new_frame = b"\xff\xd8\xffnew-frame" + b"x" * 4096 + b"\xff\xd9"
        destination = self.root / "preview.jpg"
        artifact = self.root / "artifact.jpg"
        temporary = self.root / ".preview.jpg.staged.tmp"
        destination.write_bytes(old_frame)
        artifact.write_bytes(new_frame)
        half_written = threading.Event()
        finish_write = threading.Event()
        observed: list[bytes] = []

        def read_during_write() -> None:
            if half_written.wait(timeout=2):
                observed.append(destination.read_bytes())
            finish_write.set()

        reader = threading.Thread(target=read_during_write)
        reader.start()
        info = {
            "path": str(artifact),
            "bytes": len(new_frame),
            "url": "https://example.test",
            "title": "Example",
            "heading": "",
        }
        staged_file = _StagedTemporaryFile(temporary, half_written, finish_write)
        try:
            with patch("browser.mcp.repl_json", new=AsyncMock(return_value=info)), patch(
                "browser.tempfile.NamedTemporaryFile", return_value=staged_file
            ):
                path, metadata = await browser._capture("tab-atomic", destination, False, 62, {})
        finally:
            finish_write.set()
            reader.join(timeout=2)
            browser._page_titles.pop("tab-atomic", None)

        self.assertEqual(observed, [old_frame])
        self.assertEqual(path, destination)
        self.assertEqual(destination.read_bytes(), new_frame)
        self.assertEqual(metadata["bytes"], len(new_frame))
        self.assertFalse(artifact.exists())
        self.assertFalse(temporary.exists())

    async def test_replace_failure_preserves_old_frame_and_removes_temporary_files(self):
        old_frame = b"\xff\xd8\xffold-frame\xff\xd9"
        new_frame = b"\xff\xd8\xffnew-frame\xff\xd9"
        destination = self.root / "preview.jpg"
        artifact = self.root / "artifact.jpg"
        destination.write_bytes(old_frame)
        artifact.write_bytes(new_frame)
        info = {
            "path": str(artifact),
            "bytes": len(new_frame),
            "url": "https://example.test",
            "title": "Example",
            "heading": "",
        }

        try:
            with patch("browser.mcp.repl_json", new=AsyncMock(return_value=info)), patch(
                "pathlib.Path.replace", side_effect=OSError("replace failed")
            ):
                with self.assertRaisesRegex(OSError, "replace failed"):
                    await browser._capture("tab-failure", destination, False, 62, {})
        finally:
            browser._page_titles.pop("tab-failure", None)

        self.assertEqual(destination.read_bytes(), old_frame)
        self.assertFalse(artifact.exists())
        self.assertEqual(list(self.root.glob(".preview.jpg.*.tmp")), [])
