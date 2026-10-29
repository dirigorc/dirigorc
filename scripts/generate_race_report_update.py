#!/usr/bin/env python3
"""Generate Dirigo Jekyll update/event files from a forwarded race report email.

This script is designed for GitHub Actions. It reads a repository_dispatch or
workflow_dispatch payload, calls the OpenAI Responses API, writes allowed files,
and emits a PR body summary.
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import email
from email import policy
import json
import mimetypes
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
PROMPT_PATHS = {
    "race-report": ROOT / ".github/prompts/race-report-to-jekyll-update.md",
    "calendar-event": ROOT / ".github/prompts/calendar-event-to-jekyll.md",
}
PR_BODY_PATH = ROOT / "tmp/race-report-pr-body.md"
PR_TITLE_PATH = ROOT / "tmp/race-report-pr-title.txt"
GENERATED_FILES_PATH = ROOT / "tmp/generated-files.txt"
ALLOWED_PREFIXES = ("_posts/", "_events/", "updates/tags/")
ATTACHMENT_PREFIX = "assets/images/email"
IMAGE_CONTENT_TYPES = {"image/jpeg", "image/png", "image/gif", "image/webp", "image/avif"}
URL_PATTERN = re.compile(r"https?://[^\s<>()\"']+", flags=re.IGNORECASE)
FRONT_MATTER_STRING_KEYS = {
    "title",
    "description",
    "category",
    "layout",
    "layout_style",
    "stat",
    "summary",
    "alt",
    "label",
    "url",
    "src",
    "tag",
    "time",
    "type",
    "location",
    "team_note",
    "recurrence",
    "event_url",
    "registration_url",
    "results_url",
    "related_update",
}
FORBIDDEN_PUBLIC_BODY_PATTERNS = [
    re.compile(r"rename\s+agentic\s+option", flags=re.IGNORECASE),
    re.compile(r"backward\s+compatibility", flags=re.IGNORECASE),
    re.compile(r"results were provided by.*source", flags=re.IGNORECASE),
    re.compile(r"if you have race result links or additional photos to add", flags=re.IGNORECASE),
    re.compile(r"please share.*we can update this post", flags=re.IGNORECASE),
]


def read_text(path: Path, limit: int | None = None) -> str:
    text = path.read_text(encoding="utf-8")
    if limit and len(text) > limit:
        return text[:limit] + "\n\n[truncated]\n"
    return text


def slugify(value: str) -> str:
    value = value.lower()
    value = re.sub(r"[^a-z0-9]+", "-", value)
    return value.strip("-")


def yaml_double_quoted(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def unquote_yaml_scalar(value: str) -> str:
    raw = value.strip()
    if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in {'"', "'"}:
        try:
            return json.loads(raw) if raw[0] == '"' else raw[1:-1]
        except json.JSONDecodeError:
            return raw[1:-1]
    return raw


def yaml_quote_if_plain(value: str) -> str:
    stripped = value.strip()
    if not stripped:
        return stripped
    if stripped[0] in {'"', "'", "|", ">", "[", "{", "&", "*", "!", "<", "@"}:
        return stripped
    if stripped in {"true", "false", "null", "~"}:
        return stripped
    if re.fullmatch(r"-?\d+(\.\d+)?", stripped):
        return stripped
    return yaml_double_quoted(stripped)


def safe_path(path_value: str, allowed_prefixes: tuple[str, ...] = ALLOWED_PREFIXES) -> Path:
    if path_value.startswith("/") or ".." in Path(path_value).parts:
        raise ValueError(f"Unsafe generated path: {path_value}")
    normalized = path_value.replace("\\", "/")
    if not normalized.startswith(allowed_prefixes):
        raise ValueError(f"Generated path is outside allowed content dirs: {path_value}")
    return ROOT / normalized


def safe_attachment_name(filename: str, index: int, content_type: str) -> str:
    stem = Path(filename or f"attachment-{index}").stem
    suffix = Path(filename or "").suffix.lower()
    if not suffix:
        suffix = mimetypes.guess_extension(content_type) or ".jpg"
    suffix = ".jpg" if suffix == ".jpe" else suffix
    stem = slugify(stem) or f"attachment-{index}"
    return f"{index:02d}-{stem}{suffix}"


def collect_file_list(pattern: str, limit: int = 40) -> list[str]:
    files = sorted(ROOT.glob(pattern), key=lambda p: p.as_posix(), reverse=True)
    return [p.relative_to(ROOT).as_posix() for p in files[:limit]]


def collect_recent_context() -> str:
    chunks: list[str] = []
    for pattern, label, limit in [
        ("_posts/*.md", "Recent posts", 14),
        ("_events/*.md", "Calendar events", 20),
    ]:
        files = sorted(ROOT.glob(pattern), key=lambda p: p.name, reverse=True)[:limit]
        chunks.append(f"## {label}")
        for path in files:
            chunks.append(f"\n### {path.relative_to(ROOT)}\n")
            chunks.append(read_text(path, limit=5000))

    chunks.append("\n## Existing Tag Pages\n")
    chunks.extend(collect_file_list("updates/tags/*/index.html", limit=400))

    image_files = collect_file_list("assets/images/**/*", limit=500)
    chunks.append("\n## Existing Image Assets\n")
    chunks.extend(image_files)

    return "\n".join(chunks)


def content_label(mode: str) -> str:
    return "Calendar Event" if mode == "calendar-event" else "Race Report Update"


def payload_from_github_event(event_path: Path) -> dict[str, Any]:
    event = json.loads(event_path.read_text(encoding="utf-8"))
    if "client_payload" in event:
        return event["client_payload"] or {}
    return {
        "subject": event.get("inputs", {}).get("subject", "Manual race report digest"),
        "from": event.get("inputs", {}).get("from", "manual workflow_dispatch"),
        "text": event.get("inputs", {}).get("digest_text", ""),
    }


def payload_from_file(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def normalize_email_payload(payload: dict[str, Any]) -> dict[str, Any]:
    email = payload.get("email", payload)
    subject = str(email.get("subject") or payload.get("subject") or "Race report digest")
    sender = str(email.get("from") or payload.get("from") or "Unknown sender")
    text = str(email.get("text") or email.get("body") or payload.get("text") or payload.get("body") or "")
    raw = str(email.get("raw") or payload.get("raw") or "")
    attachments = email.get("attachments") or payload.get("attachments") or []
    links = normalize_links(email.get("links") or payload.get("links") or [])
    source = str(email.get("source") or payload.get("source") or "")
    command = str(email.get("command") or payload.get("command") or "")
    content_type = str(email.get("content_type") or payload.get("content_type") or payload.get("type") or "")
    editorial_mode = str(email.get("editorial_mode") or payload.get("editorial_mode") or "")
    if source == "discord" and editorial_mode not in {"verbatim", "agentic", "self-report"}:
        editorial_mode = "verbatim"
    submitted_by = str(email.get("submitted_by") or payload.get("submitted_by") or "")
    inference = email.get("inference") if isinstance(email.get("inference"), dict) else payload.get("inference")
    if not isinstance(inference, dict):
        inference = {}
    trigger = str(email.get("trigger") or payload.get("trigger") or "")
    authored_by = str(email.get("authored_by") or payload.get("authored_by") or "")
    if not text and raw:
        text = raw
    if not links:
        links = extract_urls(text)
    if not text.strip():
        raise ValueError("No email text/body found in dispatch payload.")
    return {
        "source": source,
        "command": command,
        "content_type": content_type,
        "editorial_mode": editorial_mode,
        "submitted_by": submitted_by,
        "inference": inference,
        "trigger": trigger,
        "authored_by": authored_by,
        "subject": subject,
        "from": sender,
        "text": text,
        "body": text,
        "raw": raw,
        "attachments": attachments,
        "links": links,
    }


def extract_urls(text: str) -> list[str]:
    matches = URL_PATTERN.findall(text or "")
    unique: list[str] = []
    seen: set[str] = set()
    for value in matches:
        cleaned = value.rstrip(").,;!?")
        if not cleaned or cleaned in seen:
            continue
        seen.add(cleaned)
        unique.append(cleaned)
    return unique


def normalize_links(value: Any) -> list[str]:
    if not value:
        return []
    candidates: list[str] = []
    if isinstance(value, str):
        candidates.extend(extract_urls(value))
    elif isinstance(value, list):
        for item in value:
            if isinstance(item, str):
                candidates.extend(extract_urls(item))
            elif isinstance(item, dict):
                raw_url = item.get("url") or item.get("href")
                if isinstance(raw_url, str):
                    candidates.extend(extract_urls(raw_url))
    unique: list[str] = []
    seen: set[str] = set()
    for url in candidates:
        if url in seen:
            continue
        seen.add(url)
        unique.append(url)
    return unique


def image_dimensions(content_type: str, data: bytes) -> str:
    try:
        if content_type == "image/png" and data.startswith(b"\x89PNG\r\n\x1a\n"):
            width = int.from_bytes(data[16:20], "big")
            height = int.from_bytes(data[20:24], "big")
            return f"{width}x{height}"
        if content_type == "image/gif" and data[:3] == b"GIF":
            width = int.from_bytes(data[6:8], "little")
            height = int.from_bytes(data[8:10], "little")
            return f"{width}x{height}"
        if content_type == "image/jpeg" and data.startswith(b"\xff\xd8"):
            index = 2
            while index < len(data) - 9:
                if data[index] != 0xFF:
                    index += 1
                    continue
                marker = data[index + 1]
                index += 2
                if marker in {0xD8, 0xD9}:
                    continue
                size = int.from_bytes(data[index:index + 2], "big")
                if marker in range(0xC0, 0xC4):
                    height = int.from_bytes(data[index + 3:index + 5], "big")
                    width = int.from_bytes(data[index + 5:index + 7], "big")
                    return f"{width}x{height}"
                index += size
    except Exception:
        return ""
    return ""


def decode_attachment_data(value: str) -> bytes:
    if value.startswith("data:"):
        value = value.split(",", 1)[-1]
    return base64.b64decode(value, validate=False)


def attachments_from_raw_email(raw: str) -> list[dict[str, Any]]:
    if not raw:
        return []
    try:
        message = email.message_from_string(raw, policy=policy.default)
    except Exception:
        return []

    attachments: list[dict[str, Any]] = []
    for part in message.walk():
        content_type = part.get_content_type()
        disposition = (part.get_content_disposition() or "").lower()
        filename = part.get_filename() or ""
        if disposition != "attachment" and not filename:
            continue
        if content_type not in IMAGE_CONTENT_TYPES:
            continue
        data = part.get_payload(decode=True)
        if not data:
            continue
        attachments.append(
            {
                "filename": filename or f"attachment-{len(attachments) + 1}",
                "content_type": content_type,
                "data": data,
            }
        )
    return attachments


def attachments_from_payload(email_payload: dict[str, Any]) -> list[dict[str, Any]]:
    attachments: list[dict[str, Any]] = []
    for index, item in enumerate(email_payload.get("attachments") or [], start=1):
        content_type = str(item.get("content_type") or item.get("contentType") or "")
        filename = str(item.get("filename") or item.get("name") or f"attachment-{index}")
        data_value = item.get("data") or item.get("content") or item.get("base64")
        if content_type not in IMAGE_CONTENT_TYPES or not data_value:
            continue
        try:
            data = decode_attachment_data(str(data_value))
        except Exception:
            continue
        attachments.append({"filename": filename, "content_type": content_type, "data": data})
    attachments.extend(attachments_from_raw_email(str(email_payload.get("raw") or "")))
    return attachments


def stage_email_attachments(email_payload: dict[str, Any], today: str) -> list[dict[str, str]]:
    staged: list[dict[str, str]] = []
    seen_names: set[str] = set()
    attachment_dir = ROOT / ATTACHMENT_PREFIX / today
    attachments = attachments_from_payload(email_payload)

    for index, attachment in enumerate(attachments, start=1):
        content_type = attachment["content_type"]
        data = attachment["data"]
        if len(data) > 8 * 1024 * 1024:
            continue
        filename = safe_attachment_name(attachment.get("filename", ""), index, content_type)
        while filename in seen_names:
            filename = safe_attachment_name(f"{Path(filename).stem}-{index}{Path(filename).suffix}", index, content_type)
        seen_names.add(filename)
        relative_path = f"{ATTACHMENT_PREFIX}/{today}/{filename}"
        path = safe_path(relative_path, allowed_prefixes=(ATTACHMENT_PREFIX,))
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        staged.append(
            {
                "path": relative_path,
                "filename": attachment.get("filename", filename),
                "content_type": content_type,
                "size": str(len(data)),
                "dimensions": image_dimensions(content_type, data),
            }
        )
    return staged


MAX_SCREENSHOT_TEXT = 6000


def apply_image_readings(
    staged: list[dict[str, str]],
    readings: list[dict[str, str]],
) -> tuple[list[dict[str, str]], list[dict[str, str]]]:
    """Drop a results screenshot once its text has been read. Keep race photos."""

    by_path = {item.get("path", ""): item for item in readings}
    photos: list[dict[str, str]] = []
    notes: list[dict[str, str]] = []
    for item in staged:
        reading = by_path.get(item["path"])
        text = str((reading or {}).get("text") or "").strip()
        if reading and reading.get("kind") == "stats-screenshot" and text:
            notes.append(
                {
                    "path": item["path"],
                    "filename": item.get("filename") or item["path"],
                    "text": text[:MAX_SCREENSHOT_TEXT],
                }
            )
            screenshot = ROOT / item["path"]
            if screenshot.is_file():
                screenshot.unlink()
            continue
        photos.append(item)
    return photos, notes


def stats_screenshot_context(notes: list[dict[str, str]]) -> str:
    if not notes:
        return ""
    blocks = [
        "# Results read from screenshots",
        "",
        "These images were results cards or timing screenshots. They were transcribed and removed, so they are not post photos. Use the transcribed names, times, places, and other visible facts. Do not invent numbers that are not written here, and do not reference the screenshot as an image.",
        "",
    ]
    for note in notes:
        blocks.extend([f"## {note['filename']}", note["text"], ""])
    return "\n".join(blocks).rstrip() + "\n"


def merge_screenshot_assumptions(result: dict[str, Any], notes: list[dict[str, str]]) -> None:
    lines = [
        f"Read {note['filename']} as a results screenshot and left that image out of the post: {note['text']}"
        for note in notes
        if note.get("text")
    ]
    if not lines:
        return
    existing = result.get("assumptions")
    kept = [item for item in existing if isinstance(item, str)] if isinstance(existing, list) else []
    result["assumptions"] = lines + [item for item in kept if item not in lines]


def attachment_reading_body(staged: list[dict[str, str]], model: str) -> dict[str, Any] | None:
    content: list[dict[str, str]] = [
        {
            "type": "input_text",
            "text": (
                "Classify each image and transcribe results screenshots.\n"
                "kind is stats-screenshot only when the image is primarily a results page, timing app card, leaderboard, or other graphic made to display race statistics.\n"
                "A photograph of a runner, finish, course, crowd, or medal is race-photo even when a bib number is visible.\n"
                "For a stats-screenshot, text is a verbatim transcription of the visible facts: athlete, club, bib, race, date, location, times, pace, and places. Keep every number. Do not add facts that are not visible.\n"
                "For a race-photo, text is an empty string.\n"
                "Return one entry for each image path."
            ),
        }
    ]
    included = False
    for item in staged:
        path = ROOT / item["path"]
        if not path.is_file() or item.get("content_type") not in IMAGE_CONTENT_TYPES:
            continue
        encoded = base64.b64encode(path.read_bytes()).decode("ascii")
        content.append({"type": "input_text", "text": f"Image path: {item['path']}"})
        content.append(
            {
                "type": "input_image",
                "image_url": f"data:{item['content_type']};base64,{encoded}",
                "detail": "high",
            }
        )
        included = True
    if not included:
        return None
    return {
        "model": model,
        "input": [{"role": "user", "content": content}],
        "text": {
            "format": {
                "type": "json_schema",
                "name": "attachment_image_readings",
                "strict": True,
                "schema": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "images": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "additionalProperties": False,
                                "properties": {
                                    "path": {"type": "string"},
                                    "kind": {"type": "string", "enum": ["race-photo", "stats-screenshot"]},
                                    "text": {"type": "string"},
                                },
                                "required": ["path", "kind", "text"],
                            },
                        }
                    },
                    "required": ["images"],
                },
            }
        },
    }


def read_attachment_images(staged: list[dict[str, str]], model: str) -> list[dict[str, str]]:
    body = attachment_reading_body(staged, model)
    if body is None:
        return []
    result = post_openai(body)
    images = result.get("images")
    if not isinstance(images, list):
        return []
    readings: list[dict[str, str]] = []
    for item in images:
        if not isinstance(item, dict):
            continue
        kind = item.get("kind")
        if kind not in {"race-photo", "stats-screenshot"}:
            continue
        readings.append(
            {
                "path": str(item.get("path") or ""),
                "kind": str(kind),
                "text": str(item.get("text") or "").strip()[:MAX_SCREENSHOT_TEXT],
            }
        )
    return readings


def separate_results_screenshots(
    staged: list[dict[str, str]],
    model: str,
) -> tuple[list[dict[str, str]], list[dict[str, str]]]:
    if not staged:
        return staged, []
    try:
        readings = read_attachment_images(staged, model)
    except Exception as error:
        print(f"Results screenshot reading failed; keeping every image. {error}", file=sys.stderr)
        return staged, []
    return apply_image_readings(staged, readings)


def attachment_context(staged: list[dict[str, str]]) -> str:
    if not staged:
        return "No image attachments were found in the email payload."
    lines = [
        "The forwarded email included these image attachments. Results screenshots are omitted after their text is read. Use a listed photo when it fits the update, and reference the local path exactly.",
    ]
    for item in staged:
        dimensions = f", {item['dimensions']}" if item.get("dimensions") else ""
        lines.append(
            f"- `{item['path']}` ({item['content_type']}, {item['size']} bytes{dimensions}; original filename: {item['filename']})"
        )
    return "\n".join(lines)


def source_links_context(links: list[str]) -> str:
    if not links:
        return "No explicit source URLs were provided."
    lines = ["These URLs were provided explicitly in the source payload. Preserve relevant ones in front matter links."]
    for url in links:
        lines.append(f"- `{url}`")
    return "\n".join(lines)


def response_output_text(data: dict[str, Any]) -> str:
    if isinstance(data.get("output_text"), str):
        return data["output_text"]
    parts: list[str] = []
    for item in data.get("output", []):
        for content in item.get("content", []):
            if content.get("type") in {"output_text", "text"} and "text" in content:
                parts.append(content["text"])
    if parts:
        return "\n".join(parts)
    raise ValueError("Could not find text output in OpenAI response.")


def post_openai(body: dict[str, Any]) -> dict[str, Any]:
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is required.")

    request = urllib.request.Request(
        "https://api.openai.com/v1/responses",
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            raw = response.read().decode("utf-8")
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"OpenAI API request failed: {error.code}\n{detail}") from error

    return json.loads(response_output_text(json.loads(raw)))


def call_openai(prompt: str, model: str) -> dict[str, Any]:
    body = {
        "model": model,
        "input": [
            {
                "role": "system",
                "content": "You generate safe, reviewable Jekyll content changes. Return JSON only.",
            },
            {"role": "user", "content": prompt},
        ],
        "text": {
            "format": {
                "type": "json_schema",
                "name": "jekyll_content_changes",
                "strict": True,
                "schema": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "files": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "additionalProperties": False,
                                "properties": {
                                    "path": {"type": "string"},
                                    "content": {"type": "string"},
                                },
                                "required": ["path", "content"],
                            },
                        },
                        "summary": {"type": "string"},
                        "assumptions": {"type": "array", "items": {"type": "string"}},
                        "skipped_duplicates": {"type": "array", "items": {"type": "string"}},
                        "missing": {"type": "array", "items": {"type": "string"}},
                    },
                    "required": ["files", "summary", "assumptions", "skipped_duplicates", "missing"],
                },
            }
        },
    }

    return post_openai(body)


def extract_tags_from_post(content: str) -> list[str]:
    tags: list[str] = []
    in_tags = False
    for line in content.splitlines():
        if line.strip() == "---" and tags:
            break
        if re.match(r"^tags:\s*$", line):
            in_tags = True
            continue
        if in_tags:
            match = re.match(r"^\s*-\s*[\"']?(.*?)[\"']?\s*$", line)
            if match:
                tag = match.group(1).strip()
                if tag:
                    tags.append(tag)
                continue
            if line and not line.startswith((" ", "-")):
                in_tags = False
    return tags


def ensure_tag_pages(files: list[dict[str, str]]) -> list[dict[str, str]]:
    existing = {p.parent.name for p in (ROOT / "updates/tags").glob("*/index.html")}
    generated_paths = {Path(item["path"]).parent.name for item in files if item["path"].startswith("updates/tags/")}
    additions: list[dict[str, str]] = []

    for item in files:
        if not item["path"].startswith("_posts/"):
            continue
        for tag in extract_tags_from_post(item["content"]):
            slug = slugify(tag)
            if not slug or slug in existing or slug in generated_paths:
                continue
            generated_paths.add(slug)
            additions.append(
                {
                    "path": f"updates/tags/{slug}/index.html",
                    "content": (
                        "---\n"
                        f"title: {yaml_double_quoted(f'{tag} Updates | Dirigo')}\n"
                        f"description: {yaml_double_quoted(f'Dirigo updates tagged {tag}.')}\n"
                        "layout: tag\n"
                        f"tag: {yaml_double_quoted(tag)}\n"
                        "---\n"
                    ),
                }
            )
    return additions


def validate_post_tags(files: list[dict[str, str]]) -> None:
    missing = [
        item.get("path", "")
        for item in files
        if item.get("path", "").startswith("_posts/")
        and not extract_tags_from_post(item.get("content", ""))
    ]
    if missing:
        raise ValueError(
            "Every generated post must include at least one tag: " + ", ".join(missing)
        )


def normalize_front_matter(content: str) -> str:
    match = re.match(r"\A---\s*\n(.*?)\n---(\s*\n.*)?\Z", content, flags=re.DOTALL)
    if not match:
        return content

    front_matter = match.group(1)
    body = match.group(2) or "\n"
    normalized_lines: list[str] = []
    in_tags = False

    for line in front_matter.splitlines():
        stripped = line.strip()
        if re.match(r"^[A-Za-z_][\w-]*:\s*$", stripped):
            in_tags = stripped == "tags:"
            normalized_lines.append(line)
            continue

        if in_tags:
            tag_match = re.match(r"^(\s*-\s+)(.+?)\s*$", line)
            if tag_match and not tag_match.group(2).lstrip().startswith(("label:", "url:", "src:", "alt:")):
                normalized_lines.append(f"{tag_match.group(1)}{yaml_quote_if_plain(tag_match.group(2))}")
                continue
            if stripped and not line.startswith((" ", "-")):
                in_tags = False

        list_key_match = re.match(r"^(\s*-\s*)([A-Za-z_][\w-]*):\s+(.+?)\s*$", line)
        if list_key_match and list_key_match.group(2) in FRONT_MATTER_STRING_KEYS:
            normalized_lines.append(
                f"{list_key_match.group(1)}{list_key_match.group(2)}: {yaml_quote_if_plain(list_key_match.group(3))}"
            )
            continue

        key_match = re.match(r"^(\s*)([A-Za-z_][\w-]*):\s+(.+?)\s*$", line)
        if key_match and key_match.group(2) in FRONT_MATTER_STRING_KEYS:
            normalized_lines.append(
                f"{key_match.group(1)}{key_match.group(2)}: {yaml_quote_if_plain(key_match.group(3))}"
            )
            continue

        normalized_lines.append(line)

    return "---\n" + "\n".join(normalized_lines) + "\n---" + body


def normalize_generated_files(files: list[dict[str, str]]) -> None:
    for item in files:
        if item.get("path", "").startswith(("_posts/", "_events/", "updates/tags/")):
            item["content"] = normalize_front_matter(item.get("content", ""))


def sanitize_public_body_text(files: list[dict[str, str]], result: dict[str, Any]) -> None:
    removed: list[str] = []
    for item in files:
        path = item.get("path", "")
        if not path.startswith(("_posts/", "_events/")):
            continue

        content = item.get("content", "")
        match = re.match(r"\A---\s*\n(.*?)\n---(\s*\n.*)?\Z", content, flags=re.DOTALL)
        if not match:
            continue

        front_matter = match.group(1)
        body = (match.group(2) or "\n").lstrip("\n")
        lines = body.splitlines()
        kept: list[str] = []
        removed_count = 0
        for line in lines:
            stripped = line.strip()
            if stripped and any(pattern.search(stripped) for pattern in FORBIDDEN_PUBLIC_BODY_PATTERNS):
                removed_count += 1
                continue
            kept.append(line)

        if removed_count == 0:
            continue

        cleaned = "\n".join(kept)
        cleaned = re.sub(r"\n{3,}", "\n\n", cleaned).strip()
        if cleaned:
            item["content"] = f"---\n{front_matter}\n---\n\n{cleaned}\n"
        else:
            item["content"] = f"---\n{front_matter}\n---\n"
        removed.append(f"{path} ({removed_count} line(s))")

    if removed:
        result.setdefault("assumptions", []).append(
            "Removed internal/changelog or missing-link solicitation lines from generated public body copy: "
            + ", ".join(removed)
        )


def image_front_matter_block(images: list[dict[str, str]]) -> list[str]:
    if len(images) == 1:
        item = images[0]
        return [
            "layout_style: single",
            "image:",
            f"  src: {item['path']}",
            f"  alt: {yaml_double_quoted(item['alt'])}",
        ]

    lines = ["layout_style: image-row", "images:"]
    for item in images:
        lines.extend(
            [
                f"  - src: {item['path']}",
                f"    alt: {yaml_double_quoted(item['alt'])}",
            ]
        )
    return lines


def front_matter_images(front_matter: str) -> list[dict[str, str]]:
    lines = front_matter.splitlines()
    images: list[dict[str, str]] = []
    seen: set[str] = set()

    for index, line in enumerate(lines):
        match = re.match(r"^\s*-?\s*src:\s+(.+?)\s*$", line)
        if not match:
            continue
        path = unquote_yaml_scalar(match.group(1))
        if not path or path in seen:
            continue

        alt = "Dirigo race photo."
        for candidate in lines[index + 1:index + 4]:
            alt_match = re.match(r"^\s*-?\s*alt:\s+(.+?)\s*$", candidate)
            if alt_match:
                alt = unquote_yaml_scalar(alt_match.group(1))
                break
        images.append({"path": path, "alt": alt})
        seen.add(path)

    return images


def remove_front_matter_blocks(front_matter: str, keys: set[str]) -> str:
    lines = front_matter.splitlines()
    kept: list[str] = []
    index = 0
    while index < len(lines):
        key_match = re.match(r"^([A-Za-z_][\w-]*):(?:\s+.*)?$", lines[index])
        if key_match and key_match.group(1) in keys:
            index += 1
            while index < len(lines) and (lines[index].startswith((" ", "-")) or not lines[index].strip()):
                index += 1
            continue
        kept.append(lines[index])
        index += 1
    return "\n".join(kept)


def ensure_attached_images_used(staged: list[dict[str, str]], files: list[dict[str, str]], result: dict[str, Any]) -> None:
    if not staged:
        return

    generated_text = "\n".join(item.get("content", "") for item in files)
    missing = [item for item in staged if item["path"] not in generated_text]
    if not missing:
        return

    target = next(
        (
            item
            for item in files
            if item.get("path", "").startswith(("_posts/", "_events/"))
            and any(staged_item["path"] in item.get("content", "") for staged_item in staged)
        ),
        None,
    )
    if not target:
        target = next((item for item in files if item.get("path", "").startswith(("_posts/", "_events/"))), None)
    if not target:
        result.setdefault("missing", []).append("Image attachments were provided, but no generated post or event was available to attach them to.")
        return

    match = re.match(r"\A---\s*\n(.*?)\n---(\s*\n.*)?\Z", target.get("content", ""), flags=re.DOTALL)
    if not match:
        result.setdefault("missing", []).append("Image attachments were provided, but the generated post had no editable front matter.")
        return

    front_matter = match.group(1)
    body = match.group(2) or "\n"
    images = front_matter_images(front_matter)
    seen_paths = {item["path"] for item in images}
    for item in missing:
        if item["path"] in seen_paths:
            continue
        images.append({"path": item["path"], "alt": deterministic_attachment_alt(item)})
        seen_paths.add(item["path"])

    front_matter = remove_front_matter_blocks(front_matter, {"layout_style", "image", "images"})
    front_matter = front_matter.rstrip() + "\n" + "\n".join(image_front_matter_block(images))
    target["content"] = "---\n" + front_matter + "\n---" + body
    result.setdefault("assumptions", []).append("Included submitted image attachments because the source provided them and the generated update did not reference all of them.")


def write_files(files: list[dict[str, str]]) -> list[str]:
    written: list[str] = []
    for item in files:
        path = safe_path(item["path"])
        content = item["content"]
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists() and path.read_text(encoding="utf-8") == content:
            continue
        path.write_text(content, encoding="utf-8")
        written.append(path.relative_to(ROOT).as_posix())
    return written


def prune_unused_attachments(staged: list[dict[str, str]], files: list[dict[str, str]]) -> list[str]:
    generated_text = "\n".join(item.get("content", "") for item in files)
    kept: list[str] = []
    for item in staged:
        path = ROOT / item["path"]
        if item["path"] in generated_text:
            kept.append(item["path"])
            continue
        try:
            path.unlink()
        except FileNotFoundError:
            pass
    for directory in sorted((ROOT / ATTACHMENT_PREFIX).glob("*"), reverse=True):
        if directory.is_dir():
            try:
                directory.rmdir()
            except OSError:
                pass
    return kept


def content_slug(path_value: str) -> str:
    stem = Path(path_value).stem
    stem = re.sub(r"^\d{4}-\d{2}-\d{2}-", "", stem)
    return slugify(stem) or "dirigo-update"


def replace_image_alt_for_path(content: str, image_path: str, alt_text: str) -> str:
    lines = content.splitlines()
    changed = False
    for index, line in enumerate(lines):
        if image_path not in line:
            continue

        search_indexes = list(range(index, min(len(lines), index + 6))) + list(range(max(0, index - 4), index))
        for candidate_index in search_indexes:
            match = re.match(r"^(\s*alt:\s*).*$", lines[candidate_index])
            if not match:
                continue
            lines[candidate_index] = f"{match.group(1)}{yaml_double_quoted(alt_text)}"
            changed = True
            break

    return "\n".join(lines) + ("\n" if content.endswith("\n") else "") if changed else content


def descriptive_filename(filename_slug: str) -> bool:
    if not filename_slug:
        return False
    if re.fullmatch(r"(img|image|photo|attachment|screenshot|pxl|dsc|img-\d+|image-\d+|attachment-\d+)", filename_slug):
        return False
    if re.search(r"\d{5,}", filename_slug):
        return False
    words = [part for part in filename_slug.split("-") if part.isalpha() and len(part) > 2]
    return len(words) >= 2


def deterministic_attachment_alt(item: dict[str, str], fallback: str = "Dirigo race photo.") -> str:
    filename = Path(str(item.get("filename") or "")).stem
    if not descriptive_filename(slugify(filename)):
        return fallback
    readable = re.sub(r"[-_]+", " ", filename).strip()
    readable = re.sub(r"\s+", " ", readable)
    if not readable:
        return fallback
    return f"Dirigo race photo from {readable}."


def renamed_attachment_path(old_path: str, files: list[dict[str, str]], used_names: set[str]) -> str:
    staged_path = ROOT / old_path
    suffix = staged_path.suffix.lower() or ".jpg"
    original_slug = slugify(staged_path.stem)
    original_slug = re.sub(r"^\d{2}-", "", original_slug)

    referencing_file = next((item for item in files if old_path in item.get("content", "")), {})
    ref_slug = content_slug(referencing_file.get("path", "dirigo-update"))

    parts = [ref_slug]
    if original_slug and not re.fullmatch(r"(img|image|photo|attachment|screenshot|pxl|dsc)[-\w]*", original_slug):
        parts.append(original_slug)

    base = slugify("-".join(parts))[:110].strip("-") or ref_slug
    directory = old_path.rsplit("/", 1)[0]
    candidate = f"{directory}/{base}{suffix}"
    counter = 2
    while candidate in used_names or (ROOT / candidate).exists() and candidate != old_path:
        candidate = f"{directory}/{base}-{counter}{suffix}"
        counter += 1
    used_names.add(candidate)
    return candidate


def rename_kept_attachments(staged: list[dict[str, str]], files: list[dict[str, str]], kept: list[str]) -> list[str]:
    kept_set = set(kept)
    used_names: set[str] = set()
    renamed: list[str] = []

    for item in staged:
        old_path = item["path"]
        if old_path not in kept_set:
            continue
        new_path = renamed_attachment_path(old_path, files, used_names)
        old_file = ROOT / old_path
        new_file = ROOT / new_path

        if new_path != old_path:
            new_file.parent.mkdir(parents=True, exist_ok=True)
            old_file.rename(new_file)
            for generated in files:
                generated["content"] = generated.get("content", "").replace(old_path, new_path)
            item["renamed_path"] = new_path
        safe_alt = deterministic_attachment_alt(item)
        for generated in files:
            generated["content"] = replace_image_alt_for_path(generated.get("content", ""), new_path, safe_alt)
        renamed.append(new_path)

    return renamed


def self_report_context(email: dict[str, Any]) -> str:
    inference = email.get("inference") or {}
    if not isinstance(inference, dict) or not inference.get("self_report"):
        return ""
    notes = [str(note) for note in inference.get("notes") or [] if str(note).strip()]
    reported_on = str(inference.get("reported_on") or "").strip()
    date_line = f"Inferred date: {reported_on}" if reported_on else "The note already includes a date."
    note_lines = "\n".join(f"- {note}" for note in notes)
    return f"""# Self-reported result

Runner: {inference.get("runner") or "Unknown"}
The reporting user is the runner because the note does not name someone else.
{date_line}
{note_lines}

Write a short public result post that includes this runner and the reported result. Do not invent a place, time, age group, or race that is not in the note. Record each inference in assumptions.
"""


def message_author_context(email: dict[str, Any]) -> str:
    author = str(email.get("authored_by") or "").strip()
    if not author:
        return ""
    return (
        "# Message author\n\n"
        f"The note was written by {author}. "
        "The From line is the person who started the recap, who may be someone else. "
        "Do not add this production note to the public post.\n"
    )


def merge_inference_assumptions(result: dict[str, Any], email: dict[str, Any]) -> None:
    inference = email.get("inference") or {}
    if not isinstance(inference, dict):
        return
    notes = [str(note) for note in inference.get("notes") or [] if str(note).strip()]
    if not notes:
        return
    existing = result.get("assumptions")
    kept = [item for item in existing if isinstance(item, str)] if isinstance(existing, list) else []
    result["assumptions"] = notes + [item for item in kept if item not in notes]


def source_line(email: dict[str, Any], mode: str) -> str:
    source = email.get("source")
    if source == "discord":
        submitted_by = email.get("submitted_by") or email.get("from") or "Unknown Discord user"
        editorial_mode = email.get("editorial_mode") or "verbatim"
        command = email.get("command") or "recap"
        if email.get("trigger") == "reaction":
            author = str(email.get("authored_by") or "").strip()
            author_note = f", written by `{author}`" if author else ""
            return f"Source: **Discord reaction** submitted by `{submitted_by}`{author_note} ({editorial_mode} mode)"
        return f"Source: **Discord /{command}** submitted by `{submitted_by}` ({editorial_mode} mode)"
    if mode == "calendar-event":
        return f"Source note: **{email['subject']}** from `{email['from']}`"
    return f"Source email: **{email['subject']}** from `{email['from']}`"


def headline_from_text(text: str, limit: int = 100) -> str:
    for line in text.splitlines():
        line = line.strip().strip("-–—")
        if line:
            headline = re.sub(r"\s+", " ", line)
            headline = headline.rstrip(".?!")
            return headline[:limit].rstrip()
    return ""


def front_matter_title(content: str) -> str:
    match = re.search(r"^title:\s*(.+)$", content, flags=re.MULTILINE)
    if match:
        return unquote_yaml_scalar(match.group(1))
    return ""


def split_front_matter(content: str) -> tuple[str, str] | None:
    match = re.match(r"\A---\s*\n(.*?)\n---(?:\s*\n(.*))?\Z", content, flags=re.DOTALL)
    if not match:
        return None
    return match.group(1), (match.group(2) or "").strip()


def front_matter_scalar(front_matter: str, key: str) -> str:
    match = re.search(rf"^{re.escape(key)}:\s*(.+?)\s*$", front_matter, flags=re.MULTILINE)
    if not match:
        return ""
    return unquote_yaml_scalar(match.group(1))


def front_matter_list_maps(front_matter: str, key: str, fields: tuple[str, ...]) -> list[dict[str, str]]:
    lines = front_matter.splitlines()
    items: list[dict[str, str]] = []
    in_block = False
    current: dict[str, str] | None = None

    for line in lines:
        if re.match(rf"^{re.escape(key)}:\s*$", line):
            in_block = True
            current = None
            continue
        if not in_block:
            continue
        if re.match(r"^[A-Za-z_][\w-]*:", line):
            break
        item_start = re.match(r"^\s*-\s+([A-Za-z_][\w-]*):\s*(.+?)\s*$", line)
        if item_start:
            if current:
                items.append(current)
            current = {}
            if item_start.group(1) in fields:
                current[item_start.group(1)] = unquote_yaml_scalar(item_start.group(2))
            continue
        if current is None:
            continue
        field_match = re.match(r"^\s+([A-Za-z_][\w-]*):\s*(.+?)\s*$", line)
        if field_match and field_match.group(1) in fields:
            current[field_match.group(1)] = unquote_yaml_scalar(field_match.group(2))

    if current:
        items.append(current)
    return [item for item in items if any(item.get(field) for field in fields)]


def format_display_date(value: str) -> str:
    raw = value.strip().strip("\"'")
    if not raw:
        return ""
    try:
        return dt.date.fromisoformat(raw[:10]).strftime("%b %-d, %Y")
    except ValueError:
        return raw


def github_asset_url(path: str) -> str:
    repo = os.environ.get("GITHUB_REPOSITORY", "").strip()
    branch = (
        os.environ.get("PR_BRANCH", "").strip()
        or os.environ.get("GITHUB_HEAD_REF", "").strip()
        or os.environ.get("GITHUB_REF_NAME", "").strip()
    )
    if not repo or not branch:
        return path
    return f"https://raw.githubusercontent.com/{repo}/{branch}/{path.lstrip('/')}"


def content_files_for_preview(written: list[str]) -> list[str]:
    return [path for path in written if path.startswith(("_posts/", "_events/"))]


def render_post_preview(path: str, front_matter: str, body: str) -> list[str]:
    title = front_matter_scalar(front_matter, "title") or Path(path).stem
    category = front_matter_scalar(front_matter, "category") or "Update"
    summary = front_matter_scalar(front_matter, "summary")
    stat = front_matter_scalar(front_matter, "stat")
    date_text = format_display_date(front_matter_scalar(front_matter, "date"))
    images = front_matter_images(front_matter)
    links = front_matter_list_maps(front_matter, "links", ("label", "url"))

    sections = [
        f"_{category}_",
        "",
        f"# {title}",
        "",
    ]
    if summary:
        sections.extend([summary, ""])
    meta_bits = [category]
    if date_text:
        meta_bits.append(date_text)
    sections.extend([" · ".join(meta_bits), ""])
    if stat:
        sections.extend([f"**{stat}**", ""])
    for image in images:
        src = image.get("path") or image.get("src") or ""
        if not src:
            continue
        alt = image.get("alt") or "Dirigo race photo."
        sections.extend([f"![{alt}]({github_asset_url(src)})", ""])
    if body and body.strip() != summary.strip():
        sections.extend([body.strip(), ""])
    if links:
        link_bits = []
        for link in links:
            label = link.get("label") or "Link"
            url = link.get("url") or ""
            if url:
                link_bits.append(f"[{label}]({url})")
        if link_bits:
            sections.extend([" · ".join(link_bits), ""])
    return sections


def render_event_preview(path: str, front_matter: str, body: str) -> list[str]:
    title = front_matter_scalar(front_matter, "title") or Path(path).stem
    event_type = front_matter_scalar(front_matter, "type") or "Event"
    summary = front_matter_scalar(front_matter, "summary")
    team_note = front_matter_scalar(front_matter, "team_note")
    date_text = format_display_date(front_matter_scalar(front_matter, "date"))
    time_text = front_matter_scalar(front_matter, "time")
    location = front_matter_scalar(front_matter, "location")
    recurrence = front_matter_scalar(front_matter, "recurrence")
    images = front_matter_images(front_matter)
    links = front_matter_list_maps(front_matter, "links", ("label", "url"))

    sections = [
        f"_{event_type}_",
        "",
        f"# {title}",
        "",
    ]
    if summary:
        sections.extend([summary, ""])
    for image in images:
        src = image.get("path") or image.get("src") or ""
        if not src:
            continue
        alt = image.get("alt") or "Dirigo race photo."
        sections.extend([f"![{alt}]({github_asset_url(src)})", ""])

    details: list[str] = []
    if date_text:
        details.append(f"- **Date:** {date_text}")
    if time_text:
        details.append(f"- **Time:** {time_text}")
    if location:
        details.append(f"- **Location:** {location}")
    if recurrence:
        details.append(f"- **Repeats:** {recurrence}")
    if details:
        sections.extend(details + [""])
    if team_note:
        sections.extend([f"> {team_note}", ""])
    if body and body.strip() not in {summary.strip(), team_note.strip()}:
        sections.extend([body.strip(), ""])

    link_bits: list[str] = []
    for key, label in [
        ("event_url", "Event details"),
        ("registration_url", "Register"),
        ("results_url", "Results"),
        ("related_update", "Related update"),
    ]:
        url = front_matter_scalar(front_matter, key)
        if url:
            link_bits.append(f"[{label}]({url})")
    for link in links:
        label = link.get("label") or "Link"
        url = link.get("url") or ""
        if url:
            link_bits.append(f"[{label}]({url})")
    if link_bits:
        sections.extend([" · ".join(link_bits), ""])
    return sections


def render_site_preview(path: str) -> list[str]:
    content = (ROOT / path).read_text(encoding="utf-8")
    split = split_front_matter(content)
    if not split:
        return [f"### `{path}`", "", content.strip(), ""]
    front_matter, body = split
    if path.startswith("_events/"):
        return render_event_preview(path, front_matter, body)
    return render_post_preview(path, front_matter, body)


def replace_front_matter_field(front_matter: str, key: str, value: str) -> str:
    lines = front_matter.splitlines()
    field_start = next(
        (index for index, line in enumerate(lines) if re.match(rf"^{re.escape(key)}:\s*", line)),
        None,
    )
    replacement = f"{key}: {value}"
    if field_start is None:
        return front_matter.rstrip() + f"\n{replacement}"

    field_end = field_start + 1
    while field_end < len(lines):
        if re.match(r"^[A-Za-z_][\w-]*:\s*", lines[field_end]):
            break
        field_end += 1
    lines[field_start:field_end] = [replacement]
    return "\n".join(lines)


def derive_pr_title(result: dict[str, Any], files: list[dict[str, str]], email: dict[str, Any]) -> str:
    for item in files:
        if not item.get("path", "").startswith(("_posts/", "_events/")):
            continue
        title = front_matter_title(item.get("content", ""))
        if title:
            return title

    if email.get("source") == "discord":
        title = headline_from_text(email.get("text", ""))
        if title:
            return title

    summary = str(result.get("summary") or "").strip()
    if summary:
        return summary.rstrip(".")

    return str(email.get("subject") or "Race report update")


def enforce_discord_verbatim_copy(files: list[dict[str, str]], email: dict[str, Any]) -> None:
    if email.get("source") != "discord" or email.get("editorial_mode") != "verbatim":
        return

    posts = [item for item in files if item.get("path", "").startswith("_posts/")]
    if len(posts) != 1:
        raise ValueError(
            "A new verbatim Discord recap must generate exactly one post; "
            f"received {len(posts)}."
        )

    content = posts[0].get("content", "")
    match = re.match(r"\A---\s*\n(.*?)\n---(?:\s*\n.*)?\Z", content, flags=re.DOTALL)
    if not match:
        raise ValueError("The verbatim Discord recap post must contain valid front matter.")

    body = str(email.get("text") or "").strip()
    front_matter = match.group(1)
    front_matter = replace_front_matter_field(
        front_matter,
        "summary",
        yaml_double_quoted(body),
    )
    posts[0]["content"] = f"---\n{front_matter}\n---\n\n{body}\n"


def write_pr_body(result: dict[str, Any], written: list[str], email: dict[str, Any], staged: list[dict[str, str]], kept: list[str], mode: str, marker: str = "") -> None:
    PR_BODY_PATH.parent.mkdir(parents=True, exist_ok=True)
    sections: list[str] = []

    preview_paths = content_files_for_preview(written)
    if preview_paths:
        sections.extend(
            [
                "## Site preview",
                "",
                "_Roughly how this will appear on the public site._",
                "",
            ]
        )
        for index, path in enumerate(preview_paths):
            if index:
                sections.extend(["---", ""])
            sections.extend(render_site_preview(path))
    else:
        sections.extend(
            [
                f"## {content_label(mode)}",
                "",
                str(result.get("summary") or f"Generated {content_label(mode).lower()} content from a submitted note."),
                "",
            ]
        )

    notes: list[str] = [
        source_line(email, mode),
        "",
        "### Files Changed",
    ]
    if written:
        notes.extend(f"- `{path}`" for path in written)
    else:
        notes.append("- No file changes generated.")

    if staged:
        notes.extend(["", "### Email Attachments"])
        if kept:
            notes.extend(f"- Used `{path}`" for path in kept)
        unused = [
            item["path"]
            for item in staged
            if item["path"] not in kept and item.get("renamed_path") not in kept
        ]
        if unused:
            notes.extend(f"- Not used `{path}`" for path in unused)

    for key, heading in [
        ("assumptions", "Assumptions"),
        ("skipped_duplicates", "Skipped Or Merged"),
        ("missing", "Needs Review"),
    ]:
        values = [v for v in result.get(key, []) if v]
        if values:
            notes.extend(["", f"### {heading}"])
            notes.extend(f"- {value}" for value in values)

    summary = str(result.get("summary") or "").strip()
    if summary and preview_paths:
        notes.extend(["", "### Generator summary", "", summary])

    notes.extend(
        [
            "",
            f"_Generated by the {content_label(mode).lower()} automation. Please review names, dates, links, and tone before merging._",
        ]
    )

    sections.extend(
        [
            "---",
            "",
            "<details>",
            "<summary>Automation notes</summary>",
            "",
            *notes,
            "",
            "</details>",
            "",
        ]
    )
    text = "\n".join(sections).rstrip() + "\n"
    if marker:
        text = text.rstrip() + "\n\n" + marker + "\n"
    PR_BODY_PATH.write_text(text, encoding="utf-8")


def write_pr_title(title: str) -> None:
    PR_TITLE_PATH.parent.mkdir(parents=True, exist_ok=True)
    PR_TITLE_PATH.write_text(f"{title.strip()}\n", encoding="utf-8")


def write_generated_files_manifest(written: list[str]) -> None:
    GENERATED_FILES_PATH.parent.mkdir(parents=True, exist_ok=True)
    unique = []
    seen = set()
    for path in written:
        if path in seen:
            continue
        seen.add(path)
        unique.append(path)
    GENERATED_FILES_PATH.write_text("\n".join(unique) + ("\n" if unique else ""), encoding="utf-8")


def correction_wire(payload: dict) -> dict[str, Any] | None:
    email = payload.get("email")
    if not isinstance(email, dict):
        return None
    correction = email.get("correction")
    if correction is None:
        return None
    if not isinstance(correction, dict):
        raise ValueError("email.correction must be an object.")
    required = ("instruction", "instructionHash", "marker", "branch", "path", "readFrom", "reviewMessages", "mode")
    missing = [key for key in required if key not in correction]
    if missing:
        raise ValueError(f"email.correction is missing {', '.join(missing)}.")
    return correction


def git_text(branch: str, path: str) -> str:
    ref = f"origin/{branch}:{path}"
    try:
        return subprocess.check_output(["git", "show", ref], text=True, cwd=ROOT, stderr=subprocess.PIPE)
    except subprocess.CalledProcessError:
        subprocess.check_call(["git", "fetch", "origin", f"{branch}:refs/remotes/origin/{branch}"], cwd=ROOT)
        return subprocess.check_output(["git", "show", ref], text=True, cwd=ROOT)


def branch_content_paths(branch: str) -> list[str]:
    ref = f"origin/{branch}"
    try:
        output = subprocess.check_output(["git", "ls-tree", "-r", "--name-only", ref], text=True, cwd=ROOT, stderr=subprocess.PIPE)
    except subprocess.CalledProcessError:
        subprocess.check_call(["git", "fetch", "origin", f"{branch}:refs/remotes/origin/{branch}"], cwd=ROOT)
        output = subprocess.check_output(["git", "ls-tree", "-r", "--name-only", ref], text=True, cwd=ROOT)
    return [
        line for line in output.splitlines()
        if line.startswith(("_posts/", "_events/")) and line.endswith(".md")
    ]


def current_texts(wire: dict[str, Any]) -> dict[str, str]:
    if wire["path"] == "*":
        if wire["readFrom"] == "main":
            paths = []
            for folder in ("_posts", "_events"):
                base = ROOT / folder
                if base.is_dir():
                    paths.extend(item.relative_to(ROOT).as_posix() for item in sorted(base.glob("*.md")))
        else:
            paths = branch_content_paths(str(wire["branch"]))
    else:
        paths = [str(wire["path"])]
    texts: dict[str, str] = {}
    for path in paths:
        if wire["readFrom"] == "branch":
            texts[path] = git_text(str(wire["branch"]), path)
        else:
            texts[path] = (ROOT / path).read_text(encoding="utf-8")
    return texts


def front_matter_fences(content: str) -> int:
    return sum(1 for line in content.splitlines() if line.strip() == "---")


def date_line(content: str) -> str | None:
    lines = content.splitlines()
    if not lines or lines[0].strip() != "---":
        return None
    for line in lines[1:]:
        if line.strip() == "---":
            break
        if line.startswith("date:"):
            return line
    return None


def edit_existing(wire: dict[str, Any], texts: dict[str, str]) -> list[dict[str, str]]:
    if not texts:
        raise ValueError("There is no existing file to correct.")
    blocks = [f"## {path}\n\n{content}" for path, content in texts.items()]
    one_date = ""
    if wire.get("mode") == "calendar-event":
        one_date = (
            "If the instruction changes one date of a recurring event, add that date to skip_dates "
            "and leave the usual location, time, and recurrence in place.\n"
        )
    prompt = f"""
Change only the files below. Apply this instruction and return each full file:

{wire["instruction"]}

Do not create a file. Do not change a date: line. Keep exactly one front-matter pair of --- fences.
{one_date}
{chr(10).join(blocks)}
"""
    result = call_openai(prompt, os.environ.get("OPENAI_MODEL", "gpt-5-mini"))
    files = result.get("files", [])
    if not isinstance(files, list):
        raise ValueError("Model returned invalid files list.")
    edited: list[dict[str, str]] = []
    for item in files:
        if not isinstance(item, dict):
            raise ValueError("Model returned an invalid file.")
        path = str(item.get("path") or "")
        content = item.get("content")
        if path not in texts:
            raise ValueError(f"Correction tried to write {path}, which is not an existing file.")
        if not isinstance(content, str):
            raise ValueError(f"Correction returned no text for {path}.")
        if front_matter_fences(content) != 2:
            raise ValueError(f"{path} does not contain exactly one front-matter pair.")
        if date_line(content) != date_line(texts[path]):
            raise ValueError(f"{path} changes the date: line.")
        edited.append({"path": path, "content": normalize_front_matter(content)})
    return edited


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--event-path", default=os.environ.get("GITHUB_EVENT_PATH"))
    parser.add_argument("--payload-file")
    parser.add_argument("--model", default=os.environ.get("OPENAI_MODEL", "gpt-5-mini"))
    parser.add_argument("--mode", choices=sorted(PROMPT_PATHS), default=os.environ.get("CONTENT_MODE", "race-report"))
    args = parser.parse_args()

    if args.payload_file:
        payload = payload_from_file(Path(args.payload_file))
    elif args.event_path:
        payload = payload_from_github_event(Path(args.event_path))
    else:
        raise RuntimeError("--event-path or GITHUB_EVENT_PATH is required.")

    email = normalize_email_payload(payload)
    wire = correction_wire(payload)
    if wire is not None:
        if wire["mode"] != args.mode:
            raise SystemExit(f"correction.mode {wire['mode']} does not match {args.mode}")
        texts = current_texts(wire)
        files = edit_existing(wire, texts)
        written = write_files(files)
        pr_title = derive_pr_title({"summary": str(wire["instruction"])}, files, email)
        write_pr_title(pr_title)
        write_generated_files_manifest(written)
        write_pr_body({"summary": str(wire["instruction"])}, written, email, [], [], args.mode, marker=str(wire["marker"]))
        print(f"Wrote {len(written)} file(s).")
        print(f"PR title: {pr_title}")
        for path in written:
            print(path)
        return 0

    today = dt.datetime.now(dt.timezone.utc).astimezone().strftime("%Y-%m-%d")
    staged_attachments = stage_email_attachments(email, today)
    staged_attachments, screenshot_notes = separate_results_screenshots(staged_attachments, args.model)

    skill_prompt = read_text(PROMPT_PATHS[args.mode])
    context = collect_recent_context()
    prompt = f"""
Current date: {today}

Content mode: {args.mode}
Editorial mode: {email.get('editorial_mode', 'agentic')}

{skill_prompt}

# Existing Repo Context

{context}

# Email Image Attachments

{attachment_context(staged_attachments)}

{stats_screenshot_context(screenshot_notes)}
# Explicit Source URLs

{source_links_context(email.get('links', []))}

{self_report_context(email)}
{message_author_context(email)}
# Forwarded Email

From: {email['from']}
Subject: {email['subject']}

{email['text']}
"""
    result = call_openai(prompt, args.model)
    merge_inference_assumptions(result, email)
    merge_screenshot_assumptions(result, screenshot_notes)
    files = result.get("files", [])
    if not isinstance(files, list):
        raise ValueError("Model returned invalid files list.")
    enforce_discord_verbatim_copy(files, email)
    validate_post_tags(files)
    files.extend(ensure_tag_pages(files))
    ensure_attached_images_used(staged_attachments, files, result)
    sanitize_public_body_text(files, result)
    normalize_generated_files(files)
    kept_attachments = prune_unused_attachments(staged_attachments, files)
    kept_attachments = rename_kept_attachments(staged_attachments, files, kept_attachments)
    written = write_files(files)
    written.extend(path for path in kept_attachments if path not in written)
    pr_title = derive_pr_title(result, files, email)
    write_pr_title(pr_title)
    write_generated_files_manifest(written)
    write_pr_body(result, written, email, staged_attachments, kept_attachments, args.mode)
    print(f"Wrote {len(written)} file(s).")
    print(f"PR title: {pr_title}")
    for path in written:
        print(path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
