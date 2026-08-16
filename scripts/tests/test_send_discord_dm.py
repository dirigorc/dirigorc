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


if __name__ == "__main__":
    unittest.main()
