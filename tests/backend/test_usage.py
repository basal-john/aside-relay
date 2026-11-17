"""Subscription usage normalization and /api/usage."""
from tests.backend import support

import usage


class UsageTests(support.IsolatedBackendTest):
    def test_normalize_windows_payload(self):
        result = usage.normalize_usage({
            "providerId": "claude-code",
            "state": "active",
            "usage": {
                "windows": [
                    {"id": "seven_day", "usedPercent": 43.2, "resetsAt": 1794823199},
                    {"id": "five_hour", "usedPercent": 11, "resetsAt": 1794511799},
                ],
            },
        })
        self.assertEqual(result["providerId"], "claude-code")
        self.assertEqual([window["kind"] for window in result["windows"]], ["five_hour", "weekly"])
        self.assertEqual(result["windows"][0]["usedPercent"], 11)
        self.assertEqual(result["windows"][1]["label"], "Weekly")
        self.assertTrue(result["windows"][0]["resetsAt"].endswith("Z"))

    def test_normalize_rate_limits_payload(self):
        result = usage.normalize_usage({
            "providerId": "openai-codex",
            "state": "active",
            "usage": {
                "rateLimits": {
                    "primary": {"usedPercent": 0, "windowDurationMins": 300, "resetsAt": 1794513327},
                    "secondary": {"usedPercent": 2, "windowDurationMins": 10080, "resetsAt": 1795001244},
                },
            },
        })
        self.assertEqual([window["kind"] for window in result["windows"]], ["five_hour", "weekly"])
        self.assertEqual(result["windows"][1]["usedPercent"], 2)

    async def test_usage_route_for_supported_provider(self):
        self.native_call.side_effect = None
        self.native_call.return_value = {
            "providerId": "claude-code",
            "state": "active",
            "usage": {"windows": [{"id": "five_hour", "usedPercent": 10, "resetsAt": 1794511799}]},
        }
        async with support.api_client() as client:
            response = await client.get("/api/usage", params={"provider": "claude-code"})
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["providerId"], "claude-code")
        self.assertEqual(body["windows"][0]["usedPercent"], 10)
        self.native_call.assert_awaited_once_with(
            "models.getSubscriptionUsage",
            {"accountId": 0, "providerId": "claude-code"},
        )

    async def test_usage_route_for_unsupported_provider(self):
        async with support.api_client() as client:
            response = await client.get("/api/usage", params={"provider": "google"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"providerId": "google", "state": None, "windows": []})
        self.native_call.assert_not_awaited()

    async def test_usage_keeps_last_good_when_aside_returns_empty(self):
        import usage_routes
        usage_routes._last_good.clear()
        self.native_call.side_effect = None
        self.native_call.return_value = {
            "providerId": "claude-code",
            "state": "active",
            "usage": {"windows": [{"id": "five_hour", "usedPercent": 16, "resetsAt": 1794511799}]},
        }
        async with support.api_client() as client:
            first = await client.get("/api/usage", params={"provider": "claude-code"})
            self.native_call.return_value = {"providerId": "claude-code", "state": "active", "usage": None}
            second = await client.get("/api/usage", params={"provider": "claude-code"})
        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)
        self.assertEqual(first.json()["windows"][0]["usedPercent"], 16)
        self.assertEqual(second.json()["windows"][0]["usedPercent"], 16)

    def test_normalize_bb_provider(self):
        result = usage.normalize_bb_provider("claude-code", {
            "status": "ok",
            "planLabel": "Team",
            "windows": [
                {"label": "Current session", "usedPercent": 23, "resetsAt": "2026-11-12T20:00:00.000Z", "kind": "five-hour"},
                {"label": "Weekly limit", "usedPercent": 44, "resetsAt": "2026-11-18T11:00:00.000Z", "kind": "weekly"},
            ],
        })
        self.assertEqual(result["providerId"], "claude-code")
        self.assertEqual(result["planLabel"], "Team")
        self.assertEqual(result["source"], "bb")
        self.assertEqual([window["kind"] for window in result["windows"]], ["five_hour", "weekly"])
        self.assertEqual(result["windows"][0]["usedPercent"], 23)

    async def test_usage_falls_back_to_bb_when_aside_empty(self):
        import usage_routes
        from unittest.mock import AsyncMock, patch
        usage_routes._last_good.clear()
        self.native_call.side_effect = None
        self.native_call.return_value = {"providerId": "claude-code", "state": "active", "usage": None}
        fallback = {
            "providerId": "claude-code",
            "state": "active",
            "planLabel": "Team",
            "windows": [{"kind": "five_hour", "label": "5 hours", "usedPercent": 23, "resetsAt": "2026-11-12T20:00:00Z"}],
            "source": "bb",
        }
        with patch("usage_routes._bb_fallback", new=AsyncMock(return_value=fallback)):
            async with support.api_client() as client:
                response = await client.get("/api/usage", params={"provider": "claude-code"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["windows"][0]["usedPercent"], 23)
        self.assertEqual(response.json()["source"], "bb")
