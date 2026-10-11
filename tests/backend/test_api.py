"""HTTP authentication, run lifecycle, queue errors, and request recovery."""
import re
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from tests.backend import support

import followups
import native_queue
import server


class ApiTests(support.IsolatedBackendTest):
    async def test_every_protected_http_route_rejects_missing_and_wrong_credentials(self):
        protected = []
        for route in server.app.routes:
            dependant = getattr(route, "dependant", None)
            if dependant and any(item.call is server.require_auth for item in dependant.dependencies):
                protected.extend((route.path, method) for method in route.methods)
        for router in (server.native_sessions.router, server.native_sessions.projects_router,
                       server.native_files.router, server.native_browser.router, server.native_workspace.router):
            protected.extend((route.path, method) for route in router.routes for method in route.methods)
        self.assertIn(('/api/native/browser/tabs/{target_id}/control', 'POST'), protected)
        self.assertIn(('/api/native/sessions', 'GET'), protected)
        self.assertGreater(len(protected), 40)
        async with support.api_client() as client:
            for path, method in protected:
                path = re.sub(r"\{[^}]+\}", support.SESSION_ID, path)
                for headers in ({}, {"Authorization": "Bearer wrong"}):
                    with self.subTest(path=path, method=method, headers=bool(headers)):
                        client.headers.clear()
                        response = await client.request(method, path, json={}, headers=headers)
                        self.assertEqual(response.status_code, 401)
        self.native_call.assert_not_awaited()

    async def test_header_and_http_only_cookie_authenticate_but_query_token_does_not(self):
        with patch("server.sessions.session_status", new=AsyncMock(return_value="idle")), \
                patch("server.runner.get_run", return_value=None):
            async with support.api_client() as client:
                self.assertEqual((await client.get(f"/api/sessions/{support.SESSION_ID}/status")).status_code, 200)
                client.headers.clear()
                response = await client.get(f"/api/sessions/{support.SESSION_ID}/status?token={support.TEST_TOKEN}")
                self.assertEqual(response.status_code, 401)
                client.cookies.set(server.COOKIE, support.TEST_TOKEN)
                self.assertEqual((await client.get(f"/api/sessions/{support.SESSION_ID}/status")).status_code, 200)

    async def test_remote_bootstrap_rejects_spoofed_loopback_and_bad_access_assertion(self):
        with patch("server.cfaccess.verify", new=AsyncMock(return_value=None)):
            async with support.api_client() as client:
                client.headers.clear()
                for headers, status in (({}, 401), ({"X-Forwarded-For": "127.0.0.1", "X-Forwarded-Host": "localhost"}, 401), ({"cf-access-jwt-assertion": "invalid"}, 403)):
                    with self.subTest(headers=headers):
                        response = await client.get('/api/web-token', headers=headers)
                        self.assertEqual(response.status_code, status)
                        self.assertNotIn(support.TEST_TOKEN, response.text)

    async def test_authenticated_bootstrap_sets_secure_http_only_cookie(self):
        async with support.api_client() as client:
            response = await client.post('https://isolated-tests.local/api/auth')
        self.assertEqual(response.status_code, 200)
        cookie = response.headers['set-cookie'].lower()
        for attribute in ('httponly', 'secure', 'samesite=lax', 'path=/'):
            self.assertIn(attribute, cookie)

    async def test_new_run_forwards_options_and_returns_acceptance_without_waiting_for_answer(self):
        run = SimpleNamespace(session_id=support.SESSION_ID, stream_id="run-1", running=True)
        start = AsyncMock(return_value=run)
        with patch("server.runner.start_run", new=start), patch.object(server.hub, "ensure_stream"), \
                patch.object(server.hub, "watch_run", new=AsyncMock()):
            async with support.api_client() as client:
                response = await client.post('/api/runs', json={"prompt": " Hello ", "model": "model", "effort": "high", "mode": "incognito", "projectId": "project-1"})
        self.assertEqual(response.status_code, 202)
        self.assertEqual(response.json(), {"sessionId": support.SESSION_ID, "runId": "run-1", "running": True})
        self.assertEqual(start.await_args.args, ("Hello",))
        self.assertTrue(start.await_args.kwargs['incognito'])
        self.assertEqual(start.await_args.kwargs['project_id'], 'project-1')

    async def test_invalid_run_input_never_launches_an_agent(self):
        start = AsyncMock()
        with patch("server.runner.start_run", new=start):
            async with support.api_client() as client:
                for payload in ({}, {"prompt": " "}, {"prompt": False}, {"prompt": "Hi", "mode": "unknown"}, {"prompt": "Hi", "projectId": False}, {"prompt": "Hi", "model": {}}):
                    with self.subTest(payload=payload):
                        self.assertEqual((await client.post('/api/runs', json=payload)).status_code, 400)
        start.assert_not_awaited()

    async def test_failed_launch_hides_cli_update_account_and_email_diagnostics(self):
        secret_log = 'Aside CLI update available user@example.test /Users/private/account-token'
        with patch("server.runner.start_run", new=AsyncMock(side_effect=RuntimeError(secret_log))), patch("server.log.exception"):
            async with support.api_client() as client:
                response = await client.post('/api/runs', json={"prompt": "Hello"})
        self.assertEqual(response.status_code, 502)
        self.assertNotIn(secret_log, response.text)
        self.assertNotIn('user@example.test', response.text)

    async def test_continue_rejects_missing_or_busy_session_without_duplicate_launch(self):
        start = AsyncMock()
        with patch("server.runner.continue_run", new=start):
            async with support.api_client() as client:
                with patch("server.sessions.session_dir", return_value=None):
                    response = await client.post(f'/api/sessions/{support.SESSION_ID}/messages', json={"prompt": "Hello"})
                    self.assertEqual(response.status_code, 404)
                with patch("server.sessions.session_dir", return_value=self.root), patch("server.runner.get_run", return_value=SimpleNamespace(running=True)):
                    response = await client.post(f'/api/sessions/{support.SESSION_ID}/messages', json={"prompt": "Hello"})
                    self.assertEqual(response.status_code, 409)
        start.assert_not_awaited()

    async def test_abort_pauses_queue_before_stopping_run(self):
        operations = []
        async def pause(session_id): operations.append(('pause', session_id))
        async def abort(session_id): operations.append(('abort', session_id)); return True
        with patch.object(server.followup_queue, 'pause', side_effect=pause), patch("server.runner.abort", new=AsyncMock(side_effect=abort)):
            async with support.api_client() as client:
                response = await client.post(f'/api/sessions/{support.SESSION_ID}/abort')
        self.assertEqual(response.json(), {"aborted": True})
        self.assertEqual(operations, [('pause', support.SESSION_ID), ('abort', support.SESSION_ID)])

    async def test_default_steer_delivery_enqueues_then_steers_only_if_still_pending(self):
        item_id = str(uuid.uuid4())
        pending = {"items": [{"id": item_id}], "isPaused": False}
        enqueue = AsyncMock(return_value=pending)
        steer = AsyncMock(return_value={"items": [], "isPaused": False})
        with patch("server.sessions.session_dir", return_value=self.root), patch.object(server.followup_queue, 'enqueue', new=enqueue), patch.object(server.followup_queue, 'steer', new=steer):
            async with support.api_client() as client:
                response = await client.post(f'/api/sessions/{support.SESSION_ID}/followups', json={"id": item_id, "prompt": "Follow up", "delivery": "steer"})
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json()['items'], [])
                steer.assert_awaited_once()
                enqueue.return_value = {"items": [], "isPaused": False}
                steer.reset_mock()
                response = await client.post(f'/api/sessions/{support.SESSION_ID}/followups', json={"id": item_id, "prompt": "Follow up", "delivery": "steer"})
                self.assertEqual(response.status_code, 200)
                steer.assert_not_awaited()

    async def test_queue_conflicts_and_native_errors_have_actionable_statuses(self):
        item_id = str(uuid.uuid4())
        path = f'/api/sessions/{support.SESSION_ID}/followups/{item_id}'
        with patch("server.sessions.session_dir", return_value=self.root):
            async with support.api_client() as client:
                for error, status in ((followups.ItemNotFound(), 404), (followups.ItemSending(), 409), (native_queue.NativeQueueError('private daemon log'), 502)):
                    with self.subTest(error=type(error).__name__), patch.object(server.followup_queue, 'delete', new=AsyncMock(side_effect=error)):
                        response = await client.delete(path)
                        self.assertEqual(response.status_code, status)
                        self.assertNotIn('private daemon log', response.text)

    async def test_run_receipt_recovers_disconnect_without_exposing_internal_timestamps(self):
        request_id = str(uuid.uuid4())
        with patch.object(server, '_run_requests', {}):
            first, accepted = server._begin_run_request(request_id)
            repeated, again = server._begin_run_request(request_id)
            self.assertTrue(accepted)
            self.assertFalse(again)
            self.assertIs(first, repeated)
            server._finish_run_request(request_id, 'started', session_id=support.SESSION_ID, run_id='run-1')
            async with support.api_client() as client:
                response = await client.get(f'/api/run-requests/{request_id}')
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json(), {"status": "started", "sessionId": support.SESSION_ID, "runId": "run-1"})
