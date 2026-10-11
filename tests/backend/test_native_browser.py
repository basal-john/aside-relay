"""Browser control contracts and finite live preview lifecycle."""
from unittest.mock import AsyncMock, patch

from tests.backend import support

import browser
import native_browser


class NativeBrowserTests(support.IsolatedBackendTest):
    async def test_controls_forward_normalized_coordinates_and_conversation_scope(self):
        actions = [
            {"action": "click", "x": .25, "y": .75},
            {"action": "scroll", "deltaX": 10, "deltaY": -300},
            {"action": "type", "text": "Find this"},
            {"action": "key", "key": "Enter"},
            {"action": "back"}, {"action": "forward"},
            {"action": "navigate", "url": "https://example.test/page"},
        ]
        control = AsyncMock(return_value={"ok": True})
        with patch("native_browser.browser.control_tab", new=control):
            async with support.api_client() as client:
                for payload in actions:
                    with self.subTest(action=payload['action']):
                        response = await client.post(f'/api/native/browser/tabs/tab-1/control?session={support.SESSION_ID}&all=true', json=payload)
                        self.assertEqual(response.status_code, 200)
                        self.assertEqual(control.await_args.args, ('tab-1', payload['action']))
                        self.assertEqual(control.await_args.kwargs['session_id'], support.SESSION_ID)
                        self.assertTrue(control.await_args.kwargs['show_all'])
                        for key in ('x', 'y', 'text', 'key', 'url'):
                            if key in payload: self.assertEqual(control.await_args.kwargs[key], payload[key])

    async def test_invalid_control_payloads_fail_before_browser_actions(self):
        payloads = [
            {"action": "unknown"}, {"action": []}, {"action": {}},
            {"action": "click", "x": True, "y": .5}, {"action": "click", "x": -1, "y": .5},
            {"action": "scroll", "deltaY": 4001}, {"action": "scroll", "deltaY": True},
            {"action": "type", "text": "x" * 5001}, {"action": "type", "text": {}},
            {"action": "key", "key": []}, {"action": "key", "key": "Execute"},
            {"action": "navigate", "url": "javascript:alert(1)"}, {"action": "navigate", "url": "http://[invalid"},
        ]
        control = AsyncMock(return_value={"ok": True})
        with patch("native_browser.browser.control_tab", new=control):
            async with support.api_client() as client:
                for payload in payloads:
                    with self.subTest(payload=payload):
                        response = await client.post('/api/native/browser/tabs/tab-1/control', json=payload)
                        self.assertEqual(response.status_code, 400)
        control.assert_not_awaited()

    async def test_library_validates_kind_limit_and_preserves_search_scope(self):
        library = AsyncMock(return_value={"items": []})
        with patch("native_browser.browser.browser_library", new=library):
            async with support.api_client() as client:
                for kind in ('history', 'bookmarks', 'groups'):
                    response = await client.get(f'/api/native/browser/library?kind={kind}&query=%20Example%20&session={support.SESSION_ID}&limit=10')
                    self.assertEqual(response.status_code, 200)
                    library.assert_awaited_with(kind, session_id=support.SESSION_ID, query='Example', max_results=10)
                for query in ('kind=unknown', 'kind=history&limit=251', 'kind=history&limit=0'):
                    self.assertEqual((await client.get('/api/native/browser/library?' + query)).status_code, 422)

    async def test_cleanup_preserves_explicit_kept_tabs_and_rejects_bad_ids(self):
        cleanup = AsyncMock(return_value={"closed": ['tab-2']})
        with patch("native_browser.browser.clear_agent_tabs", new=cleanup):
            async with support.api_client() as client:
                response = await client.post(f'/api/native/browser/cleanup?session={support.SESSION_ID}', json={"keepTargetIds": ['tab-1']})
                self.assertEqual(response.status_code, 200)
                cleanup.assert_awaited_once_with(session_id=support.SESSION_ID, keep_target_ids=['tab-1'])
                for value in ('tab-1', [''], [False]):
                    self.assertEqual((await client.post('/api/native/browser/cleanup', json={"keepTargetIds": value})).status_code, 400)

    async def test_preview_yields_jpeg_frame_then_stops_when_client_disconnects(self):
        path = self.root / 'frame.jpg'
        frame = b'\xff\xd8\xfftest-frame'
        path.write_bytes(frame)
        request = AsyncMock()
        request.is_disconnected.side_effect = [False, True]
        with patch("native_browser.browser.find_tab", new=AsyncMock()), patch("native_browser.browser.screenshot", new=AsyncMock(return_value=(path, {}))) as screenshot, patch("native_browser.asyncio.sleep", new=AsyncMock()):
            response = await native_browser.browser_preview_stream(request, 'tab-1', session=support.SESSION_ID, show_all=False, fps=2)
            chunks = [chunk async for chunk in response.body_iterator]
        self.assertEqual(len(chunks), 1)
        self.assertIn(b'Content-Type: image/jpeg', chunks[0])
        self.assertIn(f'Content-Length: {len(frame)}'.encode(), chunks[0])
        self.assertTrue(chunks[0].endswith(frame + b'\r\n'))
        self.assertEqual(response.headers['cache-control'], 'no-store')
        screenshot.assert_awaited_once()

    async def test_preview_retries_busy_frame_but_stops_for_closed_or_sleeping_tab(self):
        for error in (browser.TabNotFound('tab-1'), browser.TabAsleep('tab-1')):
            request = AsyncMock()
            request.is_disconnected.return_value = False
            with self.subTest(error=type(error).__name__), patch("native_browser.browser.find_tab", new=AsyncMock()), patch("native_browser.browser.screenshot", new=AsyncMock(side_effect=error)):
                response = await native_browser.browser_preview_stream(request, 'tab-1', session=None, show_all=False, fps=2)
                self.assertEqual([chunk async for chunk in response.body_iterator], [])
        request = AsyncMock()
        request.is_disconnected.side_effect = [False, True]
        with patch("native_browser.browser.find_tab", new=AsyncMock()), patch("native_browser.browser.screenshot", new=AsyncMock(side_effect=browser.TooBusy())), patch("native_browser.asyncio.sleep", new=AsyncMock()) as sleep:
            response = await native_browser.browser_preview_stream(request, 'tab-1', session=None, show_all=False, fps=2)
            self.assertEqual([chunk async for chunk in response.body_iterator], [])
            sleep.assert_awaited_once()
