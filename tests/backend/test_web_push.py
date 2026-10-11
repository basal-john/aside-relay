import base64
import json
from types import SimpleNamespace
from unittest.mock import patch

from tests.backend import support
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from pywebpush import WebPushException

import web_push


def encoded(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode().rstrip("=")


def subscription(endpoint: str = "https://web.push.apple.com/device/one", origin: str = "https://aside.example") -> dict:
    key = ec.generate_private_key(ec.SECP256R1()).public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )
    return {
        "subscription": {"endpoint": endpoint, "keys": {"p256dh": encoded(key), "auth": encoded(b"a" * 16)}},
        "origin": origin,
    }


class WebPushTest(support.IsolatedBackendTest):
    def setUp(self):
        super().setUp()
        self.store = web_push.WebPushStore(self.root / "push")
        self.transport = self.enterContext(patch("web_push.webpush"))

    async def test_subscription_validation_accepts_push_services_and_rejects_ssrf(self):
        valid = subscription()
        normalized = web_push.validate_subscription(valid)
        self.assertEqual(normalized["origin"], "https://aside.example")
        self.assertEqual(normalized["subscription"]["endpoint"], valid["subscription"]["endpoint"])

        invalid = [
            subscription("http://web.push.apple.com/device/one"),
            subscription("https://127.0.0.1/push"),
            subscription("https://web.push.apple.com.attacker.example/push"),
            subscription("https://user@web.push.apple.com/push"),
            subscription(origin="http://169.254.169.254"),
            subscription(origin="https://aside.example/private"),
        ]
        for payload in invalid:
            with self.subTest(payload=payload):
                with self.assertRaisesRegex(ValueError, web_push.INVALID_SUBSCRIPTION):
                    web_push.validate_subscription(payload)

    async def test_subscription_validation_rejects_invalid_keys(self):
        for p256dh, auth in (("bad", encoded(b"a" * 16)), (subscription()["subscription"]["keys"]["p256dh"], "bad")):
            payload = subscription()
            payload["subscription"]["keys"] = {"p256dh": p256dh, "auth": auth}
            with self.subTest(p256dh=p256dh, auth=auth):
                with self.assertRaisesRegex(ValueError, web_push.INVALID_SUBSCRIPTION):
                    web_push.validate_subscription(payload)

    async def test_focus_lease_suppresses_only_the_focused_installation(self):
        first = web_push.validate_subscription(subscription())
        second = web_push.validate_subscription(subscription("https://fcm.googleapis.com/fcm/send/two"))
        first_id = self.store.subscribe(first)
        self.store.subscribe(second)
        clock = [100.0]
        with patch.object(web_push, "time", SimpleNamespace(monotonic=lambda: clock[0])):
            self.store.presence(first_id, "00000000-0000-0000-0000-000000000001", 2, True)
            self.store.presence(first_id, "00000000-0000-0000-0000-000000000001", 1, False)
            self.store.presence(first_id, "00000000-0000-0000-0000-000000000002", 1, False)
            await self.store.complete("session-one", "run-one", text="Ready", title="Conversation", has_error=False)
            clock[0] += web_push.FOCUS_LEASE_SEC + 1
            await self.store.complete("session-one", "run-two", text="Ready again", title="Conversation", has_error=False)

        endpoints = [call.kwargs["subscription_info"]["endpoint"] for call in self.transport.call_args_list]
        self.assertEqual(endpoints.count(first["subscription"]["endpoint"]), 1)
        self.assertEqual(endpoints.count(second["subscription"]["endpoint"]), 2)

    async def test_notification_uses_response_text_deep_link_and_stable_dedup_tag(self):
        record = web_push.validate_subscription(subscription())
        first_id = self.store.subscribe(record)
        self.assertEqual(self.store.subscribe(record), first_id)
        self.assertEqual(len(self.store.subscriptions), 1)
        text = "Answer <citation refs=\"source\">with evidence</citation> complete."

        await self.store.complete("session-42", "run-42", text=text, title="Actual conversation", has_error=False)
        await self.store.complete("session-42", "run-42", text=text, title="Actual conversation", has_error=False)

        payloads = [json.loads(call.kwargs["data"])["notification"] for call in self.transport.call_args_list]
        self.assertEqual(len(payloads), 2)
        self.assertEqual(payloads[0]["body"], "Answer with evidence complete.")
        self.assertEqual(payloads[0]["title"], "Actual conversation")
        self.assertEqual(payloads[0]["navigate"], "https://aside.example/c/session-42")
        self.assertEqual(payloads[0]["tag"], "aside:run-42")
        self.assertEqual(payloads[0]["tag"], payloads[1]["tag"])

    async def test_unicode_body_is_truncated_to_the_encrypted_payload_budget(self):
        self.store.subscribe(web_push.validate_subscription(subscription()))
        body = "한글🙂" * 3000

        await self.store.complete("session-long", "run-long", text=body, title="긴 응답", has_error=False)

        data = self.transport.call_args.kwargs["data"]
        notification = json.loads(data)["notification"]
        self.assertLessEqual(len(data.encode("utf-8")), web_push.MAX_PUSH_PAYLOAD_BYTES)
        self.assertTrue(notification["body"].endswith("…"))
        self.assertLess(len(notification["body"]), len(body))
        self.assertTrue(notification["navigate"].endswith("/c/session-long"))

    async def test_error_and_empty_responses_use_explicit_fallback_bodies(self):
        self.store.subscribe(web_push.validate_subscription(subscription()))

        await self.store.complete("session", "run-error", text="ignored", title="Title", has_error=True)
        await self.store.complete("session", "run-empty", text="  ", title="Title", has_error=False)

        bodies = [json.loads(call.kwargs["data"])["notification"]["body"] for call in self.transport.call_args_list]
        self.assertEqual(bodies, [
            "Your response could not finish. Tap to open the conversation.",
            "Your response is ready. Tap to open the conversation.",
        ])

    async def test_gone_endpoint_is_pruned_without_raising(self):
        record = web_push.validate_subscription(subscription())
        subscription_id = self.store.subscribe(record)
        self.transport.side_effect = WebPushException("gone", response=SimpleNamespace(status_code=410))

        await self.store.complete("session", "run", text="Ready", title="Title", has_error=False)

        self.assertNotIn(subscription_id, self.store.subscriptions)
        saved = json.loads(self.store.subscriptions_path.read_text())
        self.assertNotIn(subscription_id, saved)


if __name__ == "__main__":
    import unittest
    unittest.main()
