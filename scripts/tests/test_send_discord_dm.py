import importlib.util
import json
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = ROOT / "scripts" / "send_discord_dm.py"
SPEC = importlib.util.spec_from_file_location("send_discord_dm", MODULE_PATH)
assert SPEC and SPEC.loader
NOTIFIER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(NOTIFIER)


class FakeResponse:
    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return json.dumps(self.payload).encode("utf-8")


class DiscordDmTests(unittest.TestCase):
    def test_creates_dm_channel_then_sends_pr_link(self):
        requests = []
        responses = iter(
            [
                FakeResponse({"id": "987654321"}),
                FakeResponse({"id": "123456789"}),
            ]
        )

        def opener(request, timeout):
            requests.append((request, timeout))
            return next(responses)

        NOTIFIER.send_discord_dm(
            "bot-token",
            "111222333",
            "Diri created a PR for review: Update title\nhttps://github.com/example/pr/1",
            opener,
        )

        self.assertEqual(len(requests), 2)
        self.assertEqual(requests[0][0].full_url, "https://discord.com/api/v10/users/@me/channels")
        self.assertEqual(requests[1][0].full_url, "https://discord.com/api/v10/channels/987654321/messages")
        self.assertEqual(requests[0][0].get_header("Authorization"), "Bot bot-token")
        self.assertEqual(json.loads(requests[0][0].data), {"recipient_id": "111222333"})
        self.assertEqual(
            json.loads(requests[1][0].data),
            {
                "content": "Diri created a PR for review: Update title\nhttps://github.com/example/pr/1",
                "allowed_mentions": {"parse": []},
            },
        )
        self.assertEqual([request[1] for request in requests], [20, 20])

    def test_rejects_invalid_recipient_id_before_network_request(self):
        with self.assertRaisesRegex(ValueError, "must contain only digits"):
            NOTIFIER.send_discord_dm("bot-token", "not-a-user", "PR ready")

    def test_review_message_keeps_preview_text_and_publish_buttons(self):
        body = "\n".join(
            [
                "## Site preview",
                "",
                "_Roughly how this will appear on the public site._",
                "",
                "# Beach to Beacon",
                "",
                "Dirigo took the women's top ten.",
                "",
                "![Finish](https://raw.githubusercontent.com/dirigorc/dirigorc/automation/race-report-1/photo.jpg)",
                "",
                "<details>",
                "<summary>Automation notes</summary>",
                "do not show",
                "</details>",
            ]
        )
        message = NOTIFIER.build_review_message(
            "Beach to Beacon",
            "https://github.com/dirigorc/dirigorc/pull/41",
            "41",
            body,
        )

        self.assertEqual(
            message["content"],
            "**Beach to Beacon**\nPublish puts this on the site. Hold leaves the draft open.\nhttps://github.com/dirigorc/dirigorc/pull/41",
        )
        self.assertIn("Dirigo took the women's top ten.", message["embeds"][0]["description"])
        self.assertNotIn("do not show", message["embeds"][0]["description"])
        self.assertNotIn("Site preview", message["embeds"][0]["description"])
        self.assertEqual(message["embeds"][1], {"image": {"url": "https://raw.githubusercontent.com/dirigorc/dirigorc/automation/race-report-1/photo.jpg"}})
        self.assertEqual(
            message["components"],
            [
                {
                    "type": 1,
                    "components": [
                        {"type": 2, "style": 3, "label": "Publish", "custom_id": "pr_publish:41"},
                        {"type": 2, "style": 2, "label": "Hold", "custom_id": "pr_hold:41"},
                    ],
                }
            ],
        )

    def test_review_dm_goes_to_seth_and_notifies_a_different_user(self):
        requests = []

        def opener(request, timeout):
            requests.append(request)
            if request.full_url.endswith("/users/@me/channels"):
                recipient = json.loads(request.data)["recipient_id"]
                return FakeResponse({"id": recipient})
            return FakeResponse({"id": "message"})

        NOTIFIER.deliver_pr_review(
            "bot-token",
            approver_ids=["1227055686295359519"],
            dm_user_id="999",
            channel_id="",
            pr_number="41",
            review_message={"content": "review", "components": [{"type": 1}]},
            notice="Diri created a PR for review: Title\nhttps://github.com/example/pr/1",
            opener=opener,
        )

        payloads = [json.loads(request.data) for request in requests]
        self.assertEqual(payloads[0], {"recipient_id": "1227055686295359519"})
        self.assertEqual(payloads[1]["content"], "review")
        self.assertEqual(payloads[1]["components"][0]["type"], 1)
        self.assertEqual(payloads[2], {"recipient_id": "999"})
        self.assertEqual(
            payloads[3],
            {
                "content": "Diri created a PR for review: Title\nhttps://github.com/example/pr/1",
                "allowed_mentions": {"parse": []},
            },
        )
        self.assertTrue(requests[1].full_url.endswith("/channels/1227055686295359519/messages"))

    def test_review_channel_skips_a_second_message_to_the_approver(self):
        requests = []

        def opener(request, timeout):
            requests.append(request)
            return FakeResponse({"id": "1"})

        NOTIFIER.deliver_pr_review(
            "bot-token",
            approver_ids=["1227055686295359519", "459385898992140288"],
            dm_user_id="459385898992140288",
            channel_id="555",
            pr_number="41",
            review_message={"content": "review"},
            notice="plain",
            opener=opener,
        )

        self.assertEqual(len(requests), 1)
        self.assertTrue(requests[0].full_url.endswith("/channels/555/messages"))

    def test_review_dms_cross_link_the_other_reviewer(self):
        requests = []
        message_ids = {
            "1227055686295359519": "111",
            "459385898992140288": "222",
        }

        def opener(request, timeout):
            requests.append(request)
            if request.full_url.endswith("/users/@me/channels"):
                recipient = json.loads(request.data)["recipient_id"]
                return FakeResponse({"id": recipient})
            if request.get_method() == "POST":
                channel = request.full_url.rstrip("/").rsplit("/", 2)[-2]
                return FakeResponse({"id": message_ids[channel]})
            return FakeResponse({"id": "patched"})

        NOTIFIER.deliver_pr_review(
            "bot-token",
            approver_ids=["1227055686295359519", "459385898992140288"],
            dm_user_id="459385898992140288",
            channel_id="",
            pr_number="41",
            review_message={"content": "review", "embeds": [{"title": "Beach to Beacon"}]},
            notice="plain",
            opener=opener,
        )

        posts = [request for request in requests if request.get_method() == "POST" and request.full_url.endswith("/messages")]
        patches = [request for request in requests if request.get_method() == "PATCH"]
        self.assertEqual(len(posts), 2)
        self.assertEqual(len(patches), 2)
        self.assertNotIn("components", json.loads(posts[0].data))
        seth_buttons = json.loads(patches[0].data)["components"][0]["components"]
        crow_buttons = json.loads(patches[1].data)["components"][0]["components"]
        self.assertEqual(seth_buttons[0]["custom_id"], "pr_publish:41:459385898992140288:222")
        self.assertEqual(seth_buttons[1]["custom_id"], "pr_hold:41:459385898992140288:222")
        self.assertEqual(crow_buttons[0]["custom_id"], "pr_publish:41:1227055686295359519:111")
        self.assertFalse(any(b"plain" in request.data for request in requests))


if __name__ == "__main__":
    unittest.main()
