#!/usr/bin/env python3

import json
import os
import re
import urllib.error
import urllib.request
from collections.abc import Callable
from typing import Any


DISCORD_API_BASE = "https://discord.com/api/v10"


def discord_post(
    path: str,
    token: str,
    payload: dict[str, Any],
    opener: Callable[..., Any] = urllib.request.urlopen,
) -> dict[str, Any]:
    request = urllib.request.Request(
        f"{DISCORD_API_BASE}{path}",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bot {token}",
            "Content-Type": "application/json",
            "User-Agent": "dirigorc-pr-notifier",
        },
        method="POST",
    )
    try:
        with opener(request, timeout=20) as response:
            raw = response.read().decode("utf-8")
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Discord API failed: {error.code} {detail}") from error
    data = json.loads(raw or "{}")
    if not isinstance(data, dict):
        raise RuntimeError("Discord API returned an unexpected response.")
    return data


def send_discord_dm(
    token: str,
    recipient_id: str,
    content: str,
    opener: Callable[..., Any] = urllib.request.urlopen,
) -> None:
    if not re.fullmatch(r"\d+", recipient_id):
        raise ValueError("DISCORD_PR_DM_USER_ID must contain only digits.")
    channel = discord_post(
        "/users/@me/channels",
        token,
        {"recipient_id": recipient_id},
        opener,
    )
    channel_id = str(channel.get("id") or "")
    if not re.fullmatch(r"\d+", channel_id):
        raise RuntimeError("Discord did not return a valid direct-message channel ID.")
    discord_post(
        f"/channels/{channel_id}/messages",
        token,
        {"content": content, "allowed_mentions": {"parse": []}},
        opener,
    )


def main() -> int:
    token = os.environ.get("DISCORD_BOT_TOKEN", "").strip()
    recipient_id = os.environ.get("DISCORD_PR_DM_USER_ID", "").strip()
    pr_url = os.environ.get("PR_URL", "").strip()
    pr_title = os.environ.get("PR_TITLE", "").strip() or "Dirigo content update"
    if not token or not recipient_id:
        print(
            "::warning::Diri PR DM is not configured; set the DISCORD_BOT_TOKEN "
            "secret and DISCORD_PR_DM_USER_ID repository variable."
        )
        return 0
    if not pr_url:
        print("No PR URL was provided; skipping Diri PR DM.")
        return 0

    send_discord_dm(
        token,
        recipient_id,
        f"Diri created a PR for review: {pr_title}\n{pr_url}",
    )
    print("Diri PR DM sent.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
