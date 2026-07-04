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
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
PROMPT_PATH = ROOT / ".github/prompts/race-report-to-jekyll-update.md"
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
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


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
    editorial_mode = str(email.get("editorial_mode") or payload.get("editorial_mode") or "")
    if source == "discord" and editorial_mode not in {"verbatim", "agentic"}:
        editorial_mode = "verbatim"
    submitted_by = str(email.get("submitted_by") or payload.get("submitted_by") or "")
    if not text and raw:
        text = raw
    if not links:
        links = extract_urls(text)
    if not text.strip():
        raise ValueError("No email text/body found in dispatch payload.")
    return {
        "source": source,
        "editorial_mode": editorial_mode,
        "submitted_by": submitted_by,
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


def attachment_context(staged: list[dict[str, str]]) -> str:
    if not staged:
        return "No image attachments were found in the email payload."
    lines = [
        "The forwarded email included these image attachments. Use them only when they clearly fit a generated update or event. If used, reference the local path exactly.",
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


def call_openai(prompt: str, model: str) -> dict[str, Any]:
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is required.")

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
        match = re.match(r"^\s*src:\s+(.+?)\s*$", line)
        if not match:
            continue
        path = match.group(1).strip().strip("\"'")
        if not path or path in seen:
            continue

        alt = "Dirigo race photo."
        for candidate in lines[index + 1:index + 4]:
            alt_match = re.match(r"^\s*alt:\s+(.+?)\s*$", candidate)
            if alt_match:
                alt = alt_match.group(1).strip().strip("\"'")
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
    result.setdefault("assumptions", []).append("Included submitted image attachments because the source provided them and the draft did not reference all of them.")


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


def deterministic_attachment_alt(item: dict[str, str], fallback: str = "Dirigo race photo.") -> str:
    filename = Path(str(item.get("filename") or "")).stem
    filename_slug = slugify(filename)
    if filename_slug and not re.fullmatch(r"(img|image|photo|attachment|screenshot|pxl|dsc|img-\d+|image-\d+|attachment-\d+)", filename_slug):
        readable = re.sub(r"[-_]+", " ", filename).strip()
        readable = re.sub(r"\s+", " ", readable)
        if readable:
            return f"Dirigo race photo from {readable}."
    return fallback


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


def source_line(email: dict[str, Any]) -> str:
    source = email.get("source")
    if source == "discord":
        submitted_by = email.get("submitted_by") or email.get("from") or "Unknown Discord user"
        mode = email.get("editorial_mode") or "verbatim"
        return f"Source: **Discord /recap** submitted by `{submitted_by}` ({mode} mode)"
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
        raw = match.group(1).strip()
        if raw.startswith('"') and raw.endswith('"'):
            raw = raw[1:-1]
        return raw.strip()
    return ""


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

    return str(email.get("subject") or "Draft race report update")


def discord_verbatim_result(email: dict[str, Any], today: str) -> dict[str, Any]:
    slug = slugify(email.get("subject") or "discord-recap") or "discord-recap"
    base_path = f"_posts/{today}-{slug}"
    path = f"{base_path}.md"
    counter = 2
    while (ROOT / path).exists():
        path = f"{base_path}-{counter}.md"
        counter += 1
    title = yaml_double_quoted(str(email.get("subject") or "Discord recap"))
    links = email.get("links") or []
    links_block = ""
    if links:
        links_lines = ["links:"]
        for url in links:
            links_lines.append("  - label: Source")
            links_lines.append(f"    url: {url}")
        links_block = "\n" + "\n".join(links_lines)

    content = (
        "---\n"
        f"title: {title}\n"
        f"date: {today}\n"
        "layout: post\n"
        f"{links_block}\n"
        "---\n\n"
        f"{email['text']}"
    )
    if not content.endswith("\n"):
        content += "\n"
    return {
        "files": [
            {
                "path": path,
                "content": content,
            }
        ],
        "summary": "Created a verbatim Discord /recap draft without AI editorialization.",
        "assumptions": [],
        "skipped_duplicates": [],
        "missing": [],
    }


def write_pr_body(result: dict[str, Any], written: list[str], email: dict[str, Any], staged: list[dict[str, str]], kept: list[str]) -> None:
    PR_BODY_PATH.parent.mkdir(parents=True, exist_ok=True)
    sections = [
        "## Race Report Draft",
        "",
        result.get("summary", "Generated race report content from a forwarded email."),
        "",
        source_line(email),
        "",
        "## Files Changed",
    ]
    if written:
        sections.extend(f"- `{path}`" for path in written)
    else:
        sections.append("- No file changes generated.")

    if staged:
        sections.extend(["", "## Email Attachments"])
        if kept:
            sections.extend(f"- Used `{path}`" for path in kept)
        unused = [
            item["path"]
            for item in staged
            if item["path"] not in kept and item.get("renamed_path") not in kept
        ]
        if unused:
            sections.extend(f"- Not used `{path}`" for path in unused)

    for key, heading in [
        ("assumptions", "Assumptions"),
        ("skipped_duplicates", "Skipped Or Merged"),
        ("missing", "Needs Review"),
    ]:
        values = [v for v in result.get(key, []) if v]
        if values:
            sections.extend(["", f"## {heading}"])
            sections.extend(f"- {value}" for value in values)

    sections.extend(
        [
            "",
            "_Generated by the race report email automation. Please review names, dates, links, and tone before merging._",
        ]
    )
    PR_BODY_PATH.write_text("\n".join(sections) + "\n", encoding="utf-8")


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


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--event-path", default=os.environ.get("GITHUB_EVENT_PATH"))
    parser.add_argument("--payload-file")
    parser.add_argument("--model", default=os.environ.get("OPENAI_MODEL", "gpt-5-mini"))
    args = parser.parse_args()

    if args.payload_file:
        payload = payload_from_file(Path(args.payload_file))
    elif args.event_path:
        payload = payload_from_github_event(Path(args.event_path))
    else:
        raise RuntimeError("--event-path or GITHUB_EVENT_PATH is required.")

    email = normalize_email_payload(payload)
    today = dt.datetime.now(dt.timezone.utc).astimezone().strftime("%Y-%m-%d")
    staged_attachments = stage_email_attachments(email, today)

    use_agentic = email.get("source") != "discord" or email.get("editorial_mode") == "agentic"
    if use_agentic:
        skill_prompt = read_text(PROMPT_PATH)
        context = collect_recent_context()
        prompt = f"""
Current date: {today}

{skill_prompt}

# Existing Repo Context

{context}

# Email Image Attachments

{attachment_context(staged_attachments)}

# Explicit Source URLs

{source_links_context(email.get('links', []))}

# Forwarded Email

From: {email['from']}
Subject: {email['subject']}

{email['text']}
"""
        result = call_openai(prompt, args.model)
    else:
        result = discord_verbatim_result(email, today)
    files = result.get("files", [])
    if not isinstance(files, list):
        raise ValueError("Model returned invalid files list.")
    files.extend(ensure_tag_pages(files))
    ensure_attached_images_used(staged_attachments, files, result)
    normalize_generated_files(files)
    kept_attachments = prune_unused_attachments(staged_attachments, files)
    kept_attachments = rename_kept_attachments(staged_attachments, files, kept_attachments)
    written = write_files(files)
    written.extend(path for path in kept_attachments if path not in written)
    pr_title = derive_pr_title(result, files, email)
    write_pr_title(pr_title)
    write_generated_files_manifest(written)
    write_pr_body(result, written, email, staged_attachments, kept_attachments)
    print(f"Wrote {len(written)} file(s).")
    print(f"PR title: {pr_title}")
    for path in written:
        print(path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
