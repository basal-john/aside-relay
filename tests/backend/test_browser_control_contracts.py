"""Browser boundary regressions using real authenticated ASGI requests."""
from tests.backend import support

from unittest.mock import AsyncMock, patch

import browser


class BrowserControlContractTests(support.IsolatedBackendTest):
    async def test_open_tab_rejects_non_web_and_malformed_destinations(self):
        opened = AsyncMock(return_value={"targetId": "tab-test"})
        with patch("server.browser.open_tab", new=opened):
            async with support.api_client() as client:
                for url in ("javascript:alert(1)", "data:text/html,hello", "file:///tmp/test", "https://", "http://[invalid"):
                    with self.subTest(url=url):
                        response = await client.post("/api/tabs", json={"url": url})
                        self.assertEqual(response.status_code, 400)
                opened.assert_not_awaited()
                response = await client.post("/api/tabs", json={"url": "  https://example.test/page  "})
                self.assertEqual(response.status_code, 200)
                opened.assert_awaited_once_with("https://example.test/page", session_id=None)

    async def test_closing_a_tab_aside_will_not_close_reports_not_closable(self):
        tab = {"targetId": "tab-user", "url": "https://calendar.example/", "windowId": 7}
        extension = AsyncMock(return_value={"ok": True})
        with patch("browser.mcp.repl_json", new=AsyncMock(return_value={"id": "session-repl"})), \
             patch("browser.find_tab", new=AsyncMock(return_value=tab)), \
             patch("browser.daemon.call", new=AsyncMock(return_value={"browserBinding": {"windowId": 7}})), \
             patch("browser.daemon.extension", new=extension), \
             patch("browser.list_tabs", new=AsyncMock(return_value=[tab])):
            async with support.api_client() as client:
                response = await client.delete("/api/tabs/tab-user?all=true")
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json(), {"error": "tab_not_closable", "targetId": "tab-user"})
        extension.assert_awaited_once()

    async def test_closing_a_tab_that_goes_away_succeeds(self):
        tab = {"targetId": "tab-owned", "url": "https://example.test/", "windowId": 7}
        with patch("browser.mcp.repl_json", new=AsyncMock(return_value={"id": "session-repl"})), \
             patch("browser.find_tab", new=AsyncMock(return_value=tab)), \
             patch("browser.daemon.call", new=AsyncMock(return_value={"browserBinding": {"windowId": 7}})), \
             patch("browser.daemon.extension", new=AsyncMock(return_value={"ok": True})), \
             patch("browser.list_tabs", new=AsyncMock(return_value=[])):
            async with support.api_client() as client:
                response = await client.delete("/api/tabs/tab-owned?all=true")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"ok": True})

    async def test_click_does_not_evaluate_fields_for_unselected_actions(self):
        repl = AsyncMock(return_value={"ok": True})
        with patch("browser._require_awake", new=AsyncMock()), patch("browser.mcp.repl_json", new=repl):
            async with support.api_client() as client:
                response = await client.post("/api/native/browser/tabs/tab-test/control", json={
                    "action": "click", "x": .25, "y": .75, "deltaX": {}, "deltaY": [],
                })
        self.assertEqual(response.status_code, 200)
        code = repl.await_args.args[0]
        self.assertIn("pg.mouse.click", code)
        self.assertNotIn("pg.mouse.wheel", code)

    async def test_tab_list_only_exposes_the_public_tab_contract(self):
        public = {
            "targetId": "tab-test", "title": "Example", "url": "https://example.test/",
            "favicon": None, "active": True, "loaded": True, "lastAccessed": 123,
        }
        internal = {**public, "windowId": 99, "chromeId": 88, "index": 0, "status": "complete", "internalSentinel": "private"}
        with patch("server.browser.list_tabs", new=AsyncMock(return_value=[internal])):
            async with support.api_client() as client:
                response = await client.get("/api/tabs")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["tabs"], [public])

    async def test_scroll_requires_a_valid_preview_position(self):
        control = AsyncMock(return_value={"ok": True})
        with patch("browser.control_tab", new=control):
            async with support.api_client() as client:
                for point in ({}, {"x": True, "y": .5}, {"x": .5, "y": 2}):
                    response = await client.post("/api/native/browser/tabs/tab-test/control", json={
                        "action": "scroll", "deltaY": 300, **point,
                    })
                    self.assertEqual(response.status_code, 400)
        control.assert_not_awaited()

    async def test_scroll_moves_to_the_preview_position_before_dispatching_wheel(self):
        repl = AsyncMock(return_value={"ok": True})
        with patch("browser._require_awake", new=AsyncMock()), patch("browser.mcp.repl_json", new=repl):
            await browser.control_tab("tab-test", "scroll", x=.75, y=.25, delta_y=300)
        code = repl.await_args.args[0]
        self.assertIn("viewport.width * 0.75", code)
        self.assertIn("viewport.height * 0.25", code)
        self.assertLess(code.index("pg.mouse.move"), code.index("pg.mouse.wheel"))
