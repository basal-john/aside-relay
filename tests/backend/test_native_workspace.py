"""Contract tests for the allowlisted native workspace bridge."""
from tests.backend import support

import copy
from collections import deque

from daemon import ACCOUNT_ID
from fastapi import HTTPException


class NativeWorkspaceContractTests(support.IsolatedBackendTest):
    def setUp(self):
        super().setUp()
        self.settings = {
            "memory": {"enabled": True, "episodicRetentionDays": 30},
            "contextAwareness": {"enabled": True, "retentionDays": 7},
            "permission": {
                "rules": {
                    "allow": [{"type": "tool", "tool": "safe.tool"}],
                    "ask": [],
                    "deny": [],
                    "default": "ask",
                },
            },
            "mcp": {
                "servers": {
                    "docs": {
                        "enabled": False,
                        "transport": "streamable-http",
                        "url": "https://mcp.example.test/connect?token=secret&mode=read",
                        "headers": {"Authorization": "Bearer secret"},
                        "clientSecret": "secret",
                    },
                },
                "inventories": {
                    "docs": {"tools": [{"name": "search", "description": "Search docs"}]},
                },
            },
            "defaultModel": {"provider": "aside", "modelId": "gpt-test"},
            "defaultPermissionMode": "default",
            "agentTabs": True,
            "agentTaskNotifications": True,
            "completionSound": False,
            "followUpBehavior": "queue",
            "sidebarRecentChatLimit": 50,
            "sidepanelSessionOnTabChange": True,
            "timezone": "Asia/Seoul",
        }
        self.skill = {
            "name": "sample",
            "path": "personal/sample",
            "definitionPath": "personal/sample/SKILL.md",
            "group": "user",
            "metadata": {"agents": ["aside"]},
        }

    def response_for(self, procedure, value):
        responses = {
            "settings.getAll": self.settings,
            "projects.list": [{"id": "project-one", "name": "One"}],
            "projects.get": {"id": "project-one", "name": "One"},
            "projects.readFile": {"content": "# Instructions"},
            "projects.listSkillsForSettings": [self.skill],
            "projects.readSkillFile": {
                "content": "---\nagents: [aside]\n---\n\nUse the source.",
                "metadata": {"agents": ["aside"]},
            },
            "routines.list": [{"id": "routine-one", "name": "Daily"}],
            "routines.get": {"id": "routine-one", "revision": 4, "status": "active"},
            "sessions.listPreviewItems": [{"id": "history-one"}],
            "memory.listFiles": [{"path": "memory.md"}],
            "memory.readFile": {"path": value.get("filePath"), "content": "Remember this"},
            "contextAwareness.historyStatus": {"availableFrom": 1},
            "contextAwareness.listApplications": [{"id": "Safari"}],
            "contextAwareness.historyList": [{"timestamp": 2}],
            "models.listSettingsInventory": {"providers": [{"id": "aside"}]},
            "models.getCustomProviderConfig": {"providerId": "custom"},
            "accounts.get": {"id": "account-one", "name": "Tester"},
            "accounts.auth.devices": [{"id": "device-other", "isCurrent": False}],
        }
        return responses.get(procedure, {"ok": True, "procedure": procedure})

    def stub(self, overrides=None):
        overrides = overrides or {}
        calls = []
        queues = {
            procedure: deque(values)
            for procedure, values in overrides.items()
            if isinstance(values, tuple)
        }

        async def dispatch(procedure, value, *, mutation=False):
            calls.append((procedure, value, mutation))
            if procedure in queues:
                response = queues[procedure].popleft()
            elif procedure in overrides:
                response = overrides[procedure]
            else:
                response = self.response_for(procedure, value)
            if callable(response):
                response = response(value, mutation)
            if isinstance(response, Exception):
                raise response
            return copy.deepcopy(response)

        self.native_call.side_effect = dispatch
        return calls

    async def test_workspace_summary_covers_every_section_and_redacts_secrets(self):
        calls = self.stub()
        async with support.api_client() as client:
            response = await client.get("/api/native/workspace")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertTrue(body["available"])
        self.assertTrue(all(body["capabilities"].values()))
        self.assertEqual(set(body["sections"]), {
            "projects", "routines", "memories", "contextAwareness", "skills",
            "connections", "providers", "account", "preferences",
        })
        server = body["sections"]["connections"]["servers"][0]
        self.assertEqual(server["clientSecret"], "[redacted]")
        self.assertEqual(server["headers"], "[redacted]")
        self.assertEqual(
            server["url"],
            "https://mcp.example.test/connect?token=%5Bredacted%5D&mode=read",
        )
        expected = {
            "settings.getAll", "projects.list", "routines.list",
            "projects.listSkillsForSettings", "models.listSettingsInventory",
            "accounts.get", "accounts.auth.devices", "memory.listFiles",
            "contextAwareness.historyStatus",
        }
        self.assertEqual({procedure for procedure, _, _ in calls}, expected)
        self.assertTrue(all(not mutation for _, _, mutation in calls))

    async def test_public_read_routes_cover_all_workspace_areas(self):
        cases = [
            ("/api/native/workspace/projects", [("projects.list", {"accountId": ACCOUNT_ID}, False)]),
            (
                "/api/native/workspace/projects/project-one/instructions",
                [("projects.readFile", {
                    "accountId": ACCOUNT_ID, "projectId": "project-one", "fileName": "AGENTS.md",
                }, False)],
            ),
            (
                "/api/native/workspace/routines?project_id=project-one",
                [("routines.list", {"accountId": ACCOUNT_ID, "projectId": "project-one"}, False)],
            ),
            (
                "/api/native/workspace/routines/routine-one/history?offset=3&limit=7",
                [("sessions.listPreviewItems", {
                    "accountId": ACCOUNT_ID, "routineId": "routine-one", "parent": "all",
                    "archived": "include", "ephemeral": "include", "pinnedFirst": False,
                    "offset": 3, "limit": 7,
                }, False)],
            ),
            (
                "/api/native/workspace/memories",
                [
                    ("settings.getAll", {"accountId": ACCOUNT_ID}, False),
                    ("memory.listFiles", {"accountId": ACCOUNT_ID}, False),
                ],
            ),
            (
                "/api/native/workspace/memories/file?path=memory.md",
                [("memory.readFile", {
                    "accountId": ACCOUNT_ID, "filePath": "memory.md",
                }, False)],
            ),
            (
                "/api/native/workspace/context-awareness",
                [
                    ("settings.getAll", {"accountId": ACCOUNT_ID}, False),
                    ("contextAwareness.historyStatus", {"accountId": ACCOUNT_ID}, False),
                    ("contextAwareness.listApplications", {"accountId": ACCOUNT_ID}, False),
                ],
            ),
            (
                "/api/native/workspace/context-awareness/history?from=1&to=1000",
                [("contextAwareness.historyList", {
                    "accountId": ACCOUNT_ID, "from": 1, "to": 1000,
                }, False)],
            ),
            (
                "/api/native/workspace/skills?project_id=project-one",
                [("projects.listSkillsForSettings", {
                    "accountId": ACCOUNT_ID, "projectId": "project-one",
                }, False)],
            ),
            (
                "/api/native/workspace/skills/catalog",
                [("projects.listSkillsForSettings", {
                    "accountId": ACCOUNT_ID, "projectId": None,
                }, False)],
            ),
            (
                "/api/native/workspace/skills/personal/sample",
                [
                    ("projects.listSkillsForSettings", {
                        "accountId": ACCOUNT_ID, "projectId": None,
                    }, False),
                    ("projects.readSkillFile", {
                        "accountId": ACCOUNT_ID,
                        "projectId": None,
                        "skillPath": "personal/sample/SKILL.md",
                    }, False),
                ],
            ),
            (
                "/api/native/workspace/connections/tools/permissions",
                [("settings.getAll", {"accountId": ACCOUNT_ID}, False)],
            ),
            (
                "/api/native/workspace/connections",
                [("settings.getAll", {"accountId": ACCOUNT_ID}, False)],
            ),
            (
                "/api/native/workspace/connections/docs",
                [("settings.getAll", {"accountId": ACCOUNT_ID}, False)],
            ),
            (
                "/api/native/workspace/providers",
                [("models.listSettingsInventory", {"accountId": ACCOUNT_ID}, False)],
            ),
            (
                "/api/native/workspace/providers/custom/custom",
                [("models.getCustomProviderConfig", {
                    "accountId": ACCOUNT_ID, "providerId": "custom",
                }, False)],
            ),
            (
                "/api/native/workspace/account",
                [
                    ("accounts.get", {"accountId": ACCOUNT_ID}, False),
                    ("accounts.auth.devices", {"accountId": ACCOUNT_ID}, False),
                ],
            ),
            (
                "/api/native/workspace/preferences",
                [("settings.getAll", {"accountId": ACCOUNT_ID}, False)],
            ),
        ]
        for path, expected_calls in cases:
            with self.subTest(path=path):
                calls = self.stub()
                async with support.api_client() as client:
                    response = await client.get(path)
                self.assertEqual(response.status_code, 200, response.text)
                self.assertCountEqual(calls, expected_calls)

    async def test_project_mutation_contracts(self):
        cases = [
            (
                "POST", "/api/native/workspace/projects",
                {"id": "project-one", "name": "  One  ", "workspacePath": "  /tmp/one  "},
                "projects.create",
                {"id": "project-one", "name": "One", "workspacePath": "/tmp/one"},
            ),
            (
                "PATCH", "/api/native/workspace/projects/project-one",
                {"name": "  Renamed  "}, "projects.update",
                {"projectId": "project-one", "name": "Renamed"},
            ),
            (
                "DELETE", "/api/native/workspace/projects/project-one", None,
                "projects.delete", {"projectId": "project-one"},
            ),
            (
                "POST", "/api/native/workspace/projects/project-one/archive", None,
                "projects.archive", {"projectId": "project-one"},
            ),
            (
                "POST", "/api/native/workspace/projects/project-one/move-session",
                {"sessionId": support.SESSION_ID}, "sessions.moveToProject",
                {"projectId": "project-one", "sessionId": support.SESSION_ID},
            ),
            (
                "PATCH", "/api/native/workspace/projects/project-one/instructions",
                {"content": "# New rules"}, "projects.writeFile",
                {"projectId": "project-one", "fileName": "AGENTS.md", "content": "# New rules"},
            ),
        ]
        for method, path, body, procedure, payload in cases:
            with self.subTest(path=path):
                calls = self.stub()
                async with support.api_client() as client:
                    response = await client.request(method, path, json=body)
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(calls, [(procedure, {"accountId": ACCOUNT_ID, **payload}, True)])

    async def test_routine_mutation_contracts_and_revision_guards(self):
        calls = self.stub()
        async with support.api_client() as client:
            created = await client.post("/api/native/workspace/routines", json={
                "name": "  Daily  ", "prompt": "  Check status  ", "rrule": "FREQ=DAILY",
            })
        self.assertEqual(created.status_code, 200)
        self.assertEqual(calls, [
            ("settings.getAll", {"accountId": ACCOUNT_ID}, False),
            ("routines.create", {
                "accountId": ACCOUNT_ID,
                "name": "Daily",
                "prompt": "Check status",
                "rrule": "FREQ=DAILY",
                "environment": "device",
                "attachment": {"type": "standalone"},
                "sessionConfig": {
                    "model": self.settings["defaultModel"],
                    "permissionMode": "default",
                    "notificationsEnabled": True,
                },
            }, True),
        ])

        cases = [
            (
                "PATCH", "/api/native/workspace/routines/routine-one", {"name": "  Weekly  "},
                "routines.update", {"routineId": "routine-one", "name": "Weekly", "revision": 4},
            ),
            (
                "DELETE", "/api/native/workspace/routines/routine-one", None,
                "routines.delete", {"routineId": "routine-one", "revision": 4},
            ),
            (
                "POST", "/api/native/workspace/routines/routine-one/pause", None,
                "routines.update", {"routineId": "routine-one", "revision": 4, "status": "paused"},
            ),
            (
                "POST", "/api/native/workspace/routines/routine-one/resume", None,
                "routines.update", {"routineId": "routine-one", "revision": 4, "status": "active"},
            ),
        ]
        for method, path, body, procedure, expected in cases:
            with self.subTest(path=path):
                calls = self.stub()
                async with support.api_client() as client:
                    response = await client.request(method, path, json=body)
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(calls, [
                    ("routines.get", {
                        "accountId": ACCOUNT_ID, "routineId": "routine-one",
                    }, False),
                    (procedure, {"accountId": ACCOUNT_ID, **expected}, True),
                ])

        calls = self.stub()
        async with support.api_client() as client:
            run = await client.post("/api/native/workspace/routines/routine-one/run")
        self.assertEqual(run.status_code, 200)
        self.assertEqual(calls, [(
            "routines.runNow", {"accountId": ACCOUNT_ID, "routineId": "routine-one"}, True,
        )])

    async def test_memory_context_and_tool_permission_mutations_merge_current_settings(self):
        cases = [
            (
                "/api/native/workspace/memories/preferences",
                {"episodicRetentionDays": 90}, "memory",
                {"enabled": True, "episodicRetentionDays": 90},
            ),
            (
                "/api/native/workspace/context-awareness",
                {"screenOcr": True}, "contextAwareness",
                {"enabled": True, "retentionDays": 7, "screenOcr": True},
            ),
        ]
        for path, body, key, expected in cases:
            with self.subTest(path=path):
                calls = self.stub()
                async with support.api_client() as client:
                    response = await client.patch(path, json=body)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(calls, [
                    ("settings.getAll", {"accountId": ACCOUNT_ID}, False),
                    ("settings.set", {
                        "accountId": ACCOUNT_ID, "key": key, "value": expected,
                    }, True),
                ])

        calls = self.stub()
        async with support.api_client() as client:
            permission = await client.patch(
                "/api/native/workspace/connections/tools/permissions",
                json={"tool": "new.tool", "policy": "deny"},
            )
        self.assertEqual(permission.status_code, 200)
        updated = calls[1][1]["value"]["rules"]
        self.assertEqual(updated["default"], "ask")
        self.assertEqual(updated["allow"], [{"type": "tool", "tool": "safe.tool"}])
        self.assertEqual(updated["deny"], [{"type": "tool", "tool": "new.tool"}])
        self.assertEqual(calls[1][:1] + calls[1][2:], ("settings.set", True))

        calls = self.stub()
        async with support.api_client() as client:
            written = await client.patch(
                "/api/native/workspace/memories/file",
                json={"path": "memory.md", "content": "Updated"},
            )
            cleared = await client.request(
                "DELETE", "/api/native/workspace/context-awareness/history",
                json={"target": {"kind": "timeRange", "from": 1, "to": 2}},
            )
        self.assertEqual([written.status_code, cleared.status_code], [200, 200])
        self.assertEqual(calls, [
            ("memory.writeFile", {
                "accountId": ACCOUNT_ID, "filePath": "memory.md", "content": "Updated",
            }, True),
            ("contextAwareness.clear", {
                "accountId": ACCOUNT_ID, "target": {"kind": "timeRange", "from": 1, "to": 2},
            }, True),
        ])

    async def test_skill_mutation_contracts(self):
        simple_cases = [
            (
                "POST", "/api/native/workspace/skills",
                {"name": "mine", "description": "Mine", "body": "Body"},
                "projects.createSkill",
                {
                    "projectId": None, "name": "mine", "description": "Mine", "body": "Body",
                    "enabled": True, "keywords": [], "urlPatterns": [],
                },
            ),
            (
                "POST", "/api/native/workspace/skills/import",
                {"projectId": "project-one", "sourcePath": "  /tmp/skill  "},
                "projects.importSkillFolder",
                {"projectId": "project-one", "sourcePath": "/tmp/skill"},
            ),
            (
                "POST", "/api/native/workspace/skills/personal/sample/copy",
                {"projectId": "project-one"}, "projects.copySkillForCustomization",
                {"projectId": "project-one", "skillPath": "personal/sample"},
            ),
            (
                "PATCH", "/api/native/workspace/skills/personal/sample",
                {"projectId": "project-one", "enabled": False}, "projects.setSkillEnabled",
                {"projectId": "project-one", "skillPath": "personal/sample", "enabled": False},
            ),
            (
                "PATCH", "/api/native/workspace/skills/personal/sample",
                {"agents": ["aside", "codex"]}, "projects.setSkillAgents",
                {"projectId": None, "skillPath": "personal/sample", "agents": ["aside", "codex"]},
            ),
            (
                "DELETE", "/api/native/workspace/skills/personal/sample?project_id=project-one", None,
                "projects.deleteSkill",
                {"projectId": "project-one", "skillPath": "personal/sample"},
            ),
        ]
        for method, path, body, procedure, payload in simple_cases:
            with self.subTest(path=path, body=body):
                calls = self.stub()
                async with support.api_client() as client:
                    response = await client.request(method, path, json=body)
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(calls, [(procedure, {"accountId": ACCOUNT_ID, **payload}, True)])

        calls = self.stub()
        full = {
            "projectId": None,
            "name": "sample",
            "description": "Updated",
            "body": "New body",
            "enabled": True,
            "keywords": ["sample"],
            "urlPatterns": ["https://example.test/*"],
        }
        async with support.api_client() as client:
            response = await client.patch(
                "/api/native/workspace/skills/personal/sample", json=full,
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(calls, [
            ("projects.listSkillsForSettings", {
                "accountId": ACCOUNT_ID, "projectId": None,
            }, False),
            ("projects.updateSkill", {
                "accountId": ACCOUNT_ID,
                "skillPath": "personal/sample",
                **full,
            }, True),
        ])

    async def test_connection_provider_and_account_mutation_contracts_with_redaction(self):
        calls = self.stub({
            "mcp.saveServer": {
                "name": "docs", "clientSecret": "secret",
                "url": "https://mcp.example.test/callback?code=secret&ok=1",
            },
        })
        async with support.api_client() as client:
            created = await client.post("/api/native/workspace/connections", json={
                "name": " docs ",
                "server": {"transport": "streamable-http", "url": "https://mcp.example.test"},
                "clientSecret": "secret",
            })
        self.assertEqual(created.status_code, 200)
        self.assertEqual(created.json()["connection"]["clientSecret"], "[redacted]")
        self.assertEqual(
            created.json()["connection"]["url"],
            "https://mcp.example.test/callback?code=%5Bredacted%5D&ok=1",
        )
        self.assertEqual(calls, [(
            "mcp.saveServer",
            {
                "accountId": ACCOUNT_ID,
                "name": "docs",
                "server": {"transport": "streamable-http", "url": "https://mcp.example.test"},
                "clientSecret": "secret",
            },
            True,
        )])

        cases = [
            (
                "PATCH", "/api/native/workspace/connections/docs", {"enabled": True},
                "mcp.setEnabled", {"name": "docs", "enabled": True},
            ),
            (
                "DELETE", "/api/native/workspace/connections/docs", None,
                "mcp.deleteServer", {"name": "docs"},
            ),
            (
                "POST", "/api/native/workspace/connections/docs/refresh", None,
                "mcp.refreshTools", {"name": "docs"},
            ),
            (
                "POST", "/api/native/workspace/providers/custom", {"providers": {"local": {}}},
                "models.setCustomProvidersConfig", {"providers": {"local": {}}},
            ),
            (
                "DELETE", "/api/native/workspace/providers/custom/local", None,
                "models.removeCustomProviderConfig", {"providerId": "local"},
            ),
            (
                "POST", "/api/native/workspace/providers/local/credential",
                {"credential": {"apiKey": "secret"}}, "models.setCredential",
                {"providerId": "local", "credential": {"apiKey": "secret"}},
            ),
            (
                "DELETE", "/api/native/workspace/providers/local/credential", None,
                "models.removeCredential", {"providerId": "local"},
            ),
            (
                "PATCH", "/api/native/workspace/account/profile", {"name": "  New name  "},
                "accounts.auth.updateProfile", {"name": "New name"},
            ),
        ]
        for method, path, body, procedure, payload in cases:
            with self.subTest(path=path):
                calls = self.stub()
                async with support.api_client() as client:
                    response = await client.request(method, path, json=body)
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(calls, [(procedure, {"accountId": ACCOUNT_ID, **payload}, True)])

        calls = self.stub()
        async with support.api_client() as client:
            signed_out = await client.post(
                "/api/native/workspace/account/devices/device-other/sign-out",
            )
        self.assertEqual(signed_out.status_code, 200)
        self.assertEqual(calls, [
            ("accounts.auth.devices", {"accountId": ACCOUNT_ID}, False),
            ("accounts.auth.signOutDevice", {
                "accountId": ACCOUNT_ID, "deviceId": "device-other",
            }, True),
        ])

    async def test_preference_batch_success_and_reverse_rollback(self):
        calls = self.stub()
        async with support.api_client() as client:
            response = await client.patch("/api/native/workspace/preferences", json={
                "completionSound": True, "timezone": "UTC",
            })
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["updated"], ["completionSound", "timezone"])
        self.assertEqual(calls, [
            ("settings.getAll", {"accountId": ACCOUNT_ID}, False),
            ("settings.set", {
                "accountId": ACCOUNT_ID, "key": "completionSound", "value": True,
            }, True),
            ("settings.set", {
                "accountId": ACCOUNT_ID, "key": "timezone", "value": "UTC",
            }, True),
        ])

        failure = HTTPException(422, "Aside rejected these settings.")
        calls = self.stub({"settings.set": ({"ok": True}, failure, {"rolledBack": True})})
        async with support.api_client() as client:
            response = await client.patch("/api/native/workspace/preferences", json={
                "completionSound": True, "timezone": "UTC",
            })
        self.assertEqual(response.status_code, 422)
        self.assertEqual(calls[-1], (
            "settings.set",
            {
                "accountId": ACCOUNT_ID,
                "key": "completionSound",
                "value": self.settings["completionSound"],
            },
            True,
        ))

    async def test_preference_rollback_failure_returns_conflict(self):
        failure = HTTPException(422, "Aside rejected these settings.")
        rollback_failure = HTTPException(503, "Aside is unavailable.")
        calls = self.stub({"settings.set": ({"ok": True}, failure, rollback_failure)})
        async with support.api_client() as client:
            response = await client.patch("/api/native/workspace/preferences", json={
                "completionSound": True, "timezone": "UTC",
            })
        self.assertEqual(response.status_code, 409)
        self.assertIn("rollback failed", response.json()["detail"].lower())
        self.assertEqual([value["key"] for procedure, value, _ in calls if procedure == "settings.set"], [
            "completionSound", "timezone", "completionSound",
        ])

    async def test_invalid_inputs_are_rejected_without_native_mutations(self):
        cases = [
            ("PATCH", "/api/native/workspace/projects/project-one", {}, 400),
            (
                "PATCH", "/api/native/workspace/projects/project-one/instructions",
                {"content": 3}, 400,
            ),
            (
                "POST", "/api/native/workspace/routines",
                {"name": "Missing fields"}, 400,
            ),
            (
                "GET", "/api/native/workspace/context-awareness/history?from=5&to=4",
                None, 400,
            ),
            (
                "DELETE", "/api/native/workspace/context-awareness/history",
                {"target": {"kind": "timeRange", "from": 1}}, 400,
            ),
            (
                "PATCH", "/api/native/workspace/skills/personal/sample",
                {}, 400,
            ),
            (
                "PATCH", "/api/native/workspace/connections/tools/permissions",
                {"tool": "x", "policy": "sometimes"}, 400,
            ),
            (
                "POST", "/api/native/workspace/providers/custom",
                {"providers": {}}, 400,
            ),
            (
                "PATCH", "/api/native/workspace/preferences",
                {"unknown": True}, 400,
            ),
        ]
        for method, path, body, expected in cases:
            with self.subTest(path=path):
                calls = self.stub()
                async with support.api_client() as client:
                    response = await client.request(method, path, json=body)
                self.assertEqual(response.status_code, expected)
                self.assertFalse(any(mutation for _, _, mutation in calls))
