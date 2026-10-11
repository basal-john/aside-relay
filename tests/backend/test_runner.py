"""Boundary tests for runner options and native session creation."""
from unittest.mock import AsyncMock, patch

from tests.backend import support

import runner


SESSION_ID = support.SESSION_ID


class RunnerTests(support.IsolatedBackendTest):
    def setUp(self):
        super().setUp()
        self.enterContext(patch("runner.log.warning"))

    async def test_normal_start_forwards_all_cli_options(self):
        expected = object()
        start = AsyncMock(return_value=expected)
        with patch("runner._start_run", new=start):
            result = await runner.start_run(
                "Hello", model="model", effort="high", speed="fast",
                provider="provider", permission="guard", host="remote",
            )

        self.assertIs(result, expected)
        start.assert_awaited_once_with(
            "Hello", model="model", effort="high", speed="fast",
            provider="provider", permission="guard", host="remote",
        )

    async def test_incognito_project_start_uses_native_creation_path(self):
        expected = object()
        start = AsyncMock(return_value=expected)
        with patch("runner._start_native_run", new=start):
            result = await runner.start_run(
                "Hello", model="provider/model", effort="high", speed="fast",
                permission="full-access", incognito=True, project_id="project-1",
            )

        self.assertIs(result, expected)
        start.assert_awaited_once_with(
            "Hello", model="provider/model", effort="high", speed="fast",
            provider=None, permission="full-access", host=None,
            incognito=True, project_id="project-1",
        )

    async def test_native_start_creates_exact_options_then_resumes(self):
        model = {"provider": "openai", "modelId": "gpt", "thinkingLevel": "high",
                 "fastMode": True}
        binding = {"accountId": 0, "profileId": "Profile 0"}
        expected = object()
        self.native_call.side_effect = None
        self.native_call.return_value = {"id": SESSION_ID}
        resume = AsyncMock(return_value=expected)
        with patch("runner._native_model", new=AsyncMock(return_value=model)), \
                patch("runner._native_permission", new=AsyncMock(return_value="guard")), \
                patch("runner._browser_binding_with_recovery",
                      new=AsyncMock(return_value=binding)), \
                patch("runner._resume_run", new=resume):
            result = await runner._start_native_run(
                "Hello", model=None, effort=None, speed=None, provider=None,
                permission=None, host="local", incognito=True, project_id="project-1",
            )

        self.assertIs(result, expected)
        procedure, payload = self.native_call.await_args.args
        self.assertEqual(procedure, "sessions.create")
        self.assertEqual(payload["projectId"], "project-1")
        self.assertTrue(payload["incognito"])
        self.assertEqual(payload["browserBinding"], binding)
        self.assertEqual(payload["model"], model)
        self.assertEqual(payload["permissionMode"], "guard")
        resume.assert_awaited_once_with(SESSION_ID, "Hello")

    async def test_native_start_failure_deletes_empty_created_session(self):
        self.native_call.side_effect = [{"id": SESSION_ID}, None]
        with patch("runner._native_model", new=AsyncMock(return_value={})), \
                patch("runner._native_permission", new=AsyncMock(return_value="guard")), \
                patch("runner._browser_binding_with_recovery", new=AsyncMock(return_value={})), \
                patch("runner._resume_run", new=AsyncMock(side_effect=RuntimeError("resume"))):
            with self.assertRaises(RuntimeError):
                await runner._start_native_run(
                    "Hello", model=None, effort=None, speed=None, provider=None,
                    permission=None, host=None, incognito=True, project_id=None,
                )

        self.assertEqual(self.native_call.await_args_list[-1].args[0], "sessions.delete")
        self.assertEqual(self.native_call.await_args_list[-1].args[1]["sessionId"], SESSION_ID)

    async def test_remote_native_start_is_rejected_before_native_calls(self):
        with self.assertRaisesRegex(ValueError, "local host"):
            await runner._start_native_run(
                "Hello", model=None, effort=None, speed=None, provider=None,
                permission=None, host="remote", incognito=True, project_id=None,
            )

        self.native_call.assert_not_awaited()

    async def test_model_selection_validates_provider_effort_and_fast_mode(self):
        self.native_call.side_effect = [
            {"provider": "openai", "modelId": "default", "thinkingLevel": "medium",
             "fastMode": False},
            [{"provider": "anthropic", "id": "claude",
              "availableThinkingLevels": ["low", "high"], "supportsFastMode": True}],
        ]

        result = await runner._native_model(
            model="anthropic/claude", effort="high", speed="fast", provider=None
        )

        self.assertEqual(result, {
            "provider": "anthropic", "modelId": "claude",
            "thinkingLevel": "high", "fastMode": True,
        })

    async def test_permission_mapping_uses_guard_for_ask_and_preserves_full_access(self):
        self.assertEqual(await runner._native_permission("ask"), "guard")
        self.assertEqual(await runner._native_permission("full-access"), "full-access")
        self.native_call.assert_not_awaited()

    async def test_browser_binding_reopens_once_then_retries(self):
        binding = {"accountId": 0, "profileId": "Profile 0"}
        resolve = AsyncMock(side_effect=[ConnectionError("disconnected"), binding])
        reopen = AsyncMock(return_value=True)
        with patch("runner._current_browser_binding", new=resolve), \
                patch("runner._reopen_browser_profile", new=reopen), \
                patch("runner._BROWSER_START_RETRY_DELAYS", (0,)), \
                patch("runner.asyncio.sleep", new=AsyncMock()):
            result = await runner._browser_binding_with_recovery()

        self.assertEqual(result, binding)
        reopen.assert_awaited_once()
        self.assertEqual(resolve.await_count, 2)

    async def test_browser_binding_exhaustion_returns_sanitized_error(self):
        with patch("runner._current_browser_binding",
                   new=AsyncMock(side_effect=RuntimeError("email/profile raw detail"))), \
                patch("runner._reopen_browser_profile", new=AsyncMock(return_value=True)), \
                patch("runner._BROWSER_START_RETRY_DELAYS", (0, 0)), \
                patch("runner.asyncio.sleep", new=AsyncMock()):
            with self.assertRaisesRegex(ConnectionError, runner.BROWSER_DISCONNECTED_MESSAGE):
                await runner._browser_binding_with_recovery()

    async def test_resume_queue_adds_no_prompt_argument(self):
        expected = object()
        resume = AsyncMock(return_value=expected)
        with patch("runner._resume_run", new=resume):
            result = await runner.resume_queue(SESSION_ID)

        self.assertIs(result, expected)
        resume.assert_awaited_once_with(SESSION_ID, None)
