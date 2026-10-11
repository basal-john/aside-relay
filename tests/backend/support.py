"""Isolate backend tests from the signed-in Aside account and external services."""
import logging
import os
import tempfile
from pathlib import Path
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock, patch

_storage = tempfile.TemporaryDirectory(prefix="aside-relay-backend-tests-")
logging.getLogger("httpx").setLevel(logging.WARNING)
TEST_ROOT = Path(_storage.name)
TEST_TOKEN = "isolated-backend-test-token"
SESSION_ID = "TESTSESSION000001"

os.environ.update({
    "ASIDE_RELAY_TOKEN": TEST_TOKEN,
    "ASIDE_RELAY_TOKEN_FILE": str(TEST_ROOT / "token"),
    "ASIDE_USER_DIR": str(TEST_ROOT / "aside"),
    "ASIDE_BIN": str(TEST_ROOT / "unavailable-aside"),
    "ASIDE_DAEMON_URL": "http://127.0.0.1:1",
    "ASIDE_RELAY_FOLLOWUPS_FILE": str(TEST_ROOT / "followups.json"),
    "ASIDE_RELAY_WEB_PUSH_DIR": str(TEST_ROOT / "push"),
    "ASIDE_RELAY_NTFY": "",
    "ASIDE_RELAY_ACCESS_TEAM": "",
    "ASIDE_RELAY_ACCESS_AUD": "",
    "ASIDE_RELAY_ACCESS_EMAILS": "",
    "ASIDE_RELAY_CF_SERVICE_TOKEN_FILE": str(TEST_ROOT / "missing-service-token"),
    "ASIDE_RELAY_ACCESS_CNS": "",
})


class IsolatedBackendTest(IsolatedAsyncioTestCase):
    def setUp(self):
        self.storage = tempfile.TemporaryDirectory(prefix="case-", dir=TEST_ROOT)
        self.root = Path(self.storage.name)
        self.addCleanup(self.storage.cleanup)
        self.native_call = self.enterContext(patch(
            "daemon.daemon.call", new_callable=AsyncMock,
            side_effect=AssertionError("A native call must be explicitly stubbed."),
        ))
        self.extension_call = self.enterContext(patch(
            "daemon.daemon.extension", new_callable=AsyncMock,
            side_effect=AssertionError("An extension call must be explicitly stubbed."),
        ))


def api_client():
    import httpx
    import server

    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=server.app),
        base_url="http://isolated-tests.local",
        headers={"Authorization": f"Bearer {TEST_TOKEN}"},
    )
