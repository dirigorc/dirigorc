#!/usr/bin/env python3

import json
import os
import re
import urllib.error
import urllib.request
from collections.abc import Callable
from pathlib import Path
from typing import Any


DISCORD_API_BASE = "https://discord.com/api/v10"
DEFAULT_PR_APPROVER_USER_IDS = ("1227055686295359519", "459385898992140288")
IMAGE_PATTERN = re.compile(r"!\[[^\]]*\]\((https://[^)\s]+)\)")
PREVIEW_SKIP_LINES = {
    "## Site preview",
    "_Roughly how this will appear on the public site._",
}


def discord_post(
    path: str,
    token: str,
    payload: dict[str, Any],
    opener: Callable[..., Any] = urllib.request.urlopen,
    method: str = "POST",
) -> dict[str, Any]:
    request = urllib.request.Request(
        f"{DISCORD_API_BASE}{path}",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bot {token}",
            "Content-Type": "application/json",
            "User-Agent": "dirigorc-pr-notifier",
        },
        method=method,
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


def open_dm_channel(
    token: str,
    recipient_id: str,
    opener: Callable[..., Any] = urllib.request.urlopen,
) -> str:
    channel = discord_post(
        "/users/@me/channels",
        token,
        {"recipient_id": recipient_id},
        opener,
    )
    channel_id = str(channel.get("id") or "")
    if not re.fullmatch(r"\d+", channel_id):
        raise RuntimeError("Discord did not return a valid direct-message channel ID.")
    return channel_id


def send_discord_dm(
    token: str,
    recipient_id: str,
    content: str,
    opener: Callable[..., Any] = urllib.request.urlopen,
) -> None:
    if not re.fullmatch(r"\d+", recipient_id):
        raise ValueError("DISCORD_PR_DM_USER_ID must contain only digits.")
    channel_id = open_dm_channel(token, recipient_id, opener)
    discord_post(
        f"/channels/{channel_id}/messages",
        token,
        {"content": content, "allowed_mentions": {"parse": []}},
        opener,
    )


def clip_text(value: str, limit: int) -> str:
    if len(value) <= limit:
        return value
    return value[: limit - 1].rstrip() + "…"


def discord_preview(pr_body: str) -> tuple[str, list[str]]:
    preview = pr_body.split("<details>", 1)[0]
    images: list[str] = []

    def capture(match: re.Match[str]) -> str:
        images.append(match.group(1))
        return ""

    text = IMAGE_PATTERN.sub(capture, preview)
    lines: list[str] = []
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if line in PREVIEW_SKIP_LINES:
            continue
        lines.append(line)
    description = re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()
    return clip_text(description, 3500), images[:4]


def review_components(pr_number: str, sibling: tuple[str, str] | None = None) -> list[dict[str, Any]]:
    if not re.fullmatch(r"\d+", pr_number):
        return []
    suffix = f":{sibling[0]}:{sibling[1]}" if sibling else ""
    return [
        {
            "type": 1,
            "components": [
                {"type": 2, "style": 3, "label": "Publish", "custom_id": f"pr_publish:{pr_number}{suffix}"},
                {"type": 2, "style": 2, "label": "Hold", "custom_id": f"pr_hold:{pr_number}{suffix}"},
            ],
        }
    ]


def parse_snowflakes(value: str, label: str) -> list[str]:
    ids: list[str] = []
    for part in value.split(","):
        part = part.strip()
        if not part:
            continue
        if not re.fullmatch(r"\d+", part):
            raise ValueError(f"{label} must contain only digits.")
        if part not in ids:
            ids.append(part)
    return ids


def message_id(payload: dict[str, Any]) -> str:
    value = str(payload.get("id") or "")
    if not re.fullmatch(r"\d+", value):
        raise RuntimeError("Discord did not return a valid message ID.")
    return value


def build_review_message(title: str, url: str, pr_number: str, pr_body: str) -> dict[str, Any]:
    heading = title or "Dirigo update"
    description, images = discord_preview(pr_body)
    content = clip_text(
        f"**{heading}**\nPublish puts this on the site. Hold leaves the draft open.\n{url}",
        2000,
    )
    embeds: list[dict[str, Any]] = [{"title": clip_text(heading, 256), "url": url}]
    if description:
        embeds[0]["description"] = description
    embeds.extend({"image": {"url": image}} for image in images)
    payload: dict[str, Any] = {
        "content": content,
        "embeds": embeds[:10],
        "allowed_mentions": {"parse": []},
    }
    components = review_components(pr_number)
    if components:
        payload["components"] = components
    return payload


def deliver_pr_review(
    token: str,
    *,
    approver_ids: list[str],
    dm_user_id: str,
    channel_id: str,
    pr_number: str,
    review_message: dict[str, Any],
    notice: str,
    opener: Callable[..., Any] = urllib.request.urlopen,
) -> None:
    if not approver_ids or any(not re.fullmatch(r"\d+", approver_id) for approver_id in approver_ids):
        raise ValueError("DISCORD_PR_APPROVER_USER_ID must contain only digits.")
    if channel_id:
        if not re.fullmatch(r"\d+", channel_id):
            raise ValueError("DISCORD_PR_REVIEW_CHANNEL_ID must contain only digits.")
        discord_post(f"/channels/{channel_id}/messages", token, review_message, opener)
    elif len(approver_ids) == 1:
        channel = open_dm_channel(token, approver_ids[0], opener)
        discord_post(f"/channels/{channel}/messages", token, review_message, opener)
    else:
        bare = {key: value for key, value in review_message.items() if key != "components"}
        sent: list[tuple[str, str]] = []
        for approver_id in approver_ids:
            channel = open_dm_channel(token, approver_id, opener)
            created = discord_post(f"/channels/{channel}/messages", token, bare, opener)
            sent.append((channel, message_id(created)))
        for index, (channel, sent_message_id) in enumerate(sent):
            sibling = sent[1 - index] if len(sent) == 2 else None
            patched = dict(review_message)
            components = review_components(pr_number, sibling)
            if components:
                patched["components"] = components
            discord_post(
                f"/channels/{channel}/messages/{sent_message_id}",
                token,
                patched,
                opener,
                method="PATCH",
            )
    if dm_user_id and dm_user_id not in approver_ids:
        send_discord_dm(token, dm_user_id, notice, opener)


def main() -> int:
    token = os.environ.get("DISCORD_BOT_TOKEN", "").strip()
    pr_url = os.environ.get("PR_URL", "").strip()
    pr_title = os.environ.get("PR_TITLE", "").strip() or "Dirigo content update"
    if not token:
        print("::warning::Diri PR review is not configured; set the DISCORD_BOT_TOKEN secret.")
        return 0
    if not pr_url:
        print("No PR URL was provided; skipping Diri PR review.")
        return 0

    configured_approvers = os.environ.get("DISCORD_PR_APPROVER_USER_ID", "").strip()
    approver_ids = parse_snowflakes(configured_approvers, "DISCORD_PR_APPROVER_USER_ID") or list(DEFAULT_PR_APPROVER_USER_IDS)
    dm_user_id = os.environ.get("DISCORD_PR_DM_USER_ID", "").strip()
    channel_id = os.environ.get("DISCORD_PR_REVIEW_CHANNEL_ID", "").strip()
    pr_number = os.environ.get("PR_NUMBER", "").strip()
    preview_path = os.environ.get("PR_PREVIEW_PATH", "").strip()
    pr_body = ""
    if preview_path and os.path.isfile(preview_path):
        pr_body = Path(preview_path).read_text(encoding="utf-8")[:20000]

    deliver_pr_review(
        token,
        approver_ids=approver_ids,
        dm_user_id=dm_user_id,
        channel_id=channel_id,
        pr_number=pr_number,
        review_message=build_review_message(pr_title, pr_url, pr_number, pr_body),
        notice=f"Diri created a PR for review: {pr_title}\n{pr_url}",
    )
    print("Diri PR review sent.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
