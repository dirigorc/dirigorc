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
GENERATED_FILES_PATH = ROOT / "tmp/generated-files.txt"
ALLOWED_PREFIXES = ("_posts/", "_events/", "updates/tags/")
ATTACHMENT_PREFIX = "assets/images/email"
IMAGE_CONTENT_TYPES = {"image/jpeg", "image/png", "image/gif", "image/webp", "image/avif"}


def read_text(path: Path, limit: int | None = None) -> str:
    text = path.read_text(encoding="utf-8")
    if limit and len(text) > limit:
        return text[:limit] + "\n\n[truncated]\n"
    return text


def slugify(value: str) -> str:
    value = value.lower()
    value = re.sub(r"[^a-z0-9]+", "-", value)
    return value.strip("-")


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
    if not text and raw:
        text = raw
    if not text.strip():
        raise ValueError("No email text/body found in dispatch payload.")
    return {"subject": subject, "from": sender, "text": text, "raw": raw, "attachments": attachments}


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
                        f'title: "{tag} Updates | Dirigo"\n'
                        f'description: "Dirigo updates tagged {tag}."\n'
                        "layout: tag\n"
                        f'tag: "{tag}"\n'
                        "---\n"
                    ),
                }
            )
    return additions


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


def write_pr_body(result: dict[str, Any], written: list[str], email: dict[str, Any], staged: list[dict[str, str]], kept: list[str]) -> None:
    PR_BODY_PATH.parent.mkdir(parents=True, exist_ok=True)
    sections = [
        "## Race Report Draft",
        "",
        result.get("summary", "Generated race report content from a forwarded email."),
        "",
        f"Source email: **{email['subject']}** from `{email['from']}`",
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
        unused = [item["path"] for item in staged if item["path"] not in kept]
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
    skill_prompt = read_text(PROMPT_PATH)
    context = collect_recent_context()
    today = dt.datetime.now(dt.timezone.utc).astimezone().strftime("%Y-%m-%d")
    staged_attachments = stage_email_attachments(email, today)

    prompt = f"""
Current date: {today}

{skill_prompt}

# Existing Repo Context

{context}

# Email Image Attachments

{attachment_context(staged_attachments)}

# Forwarded Email

From: {email['from']}
Subject: {email['subject']}

{email['text']}
"""

    result = call_openai(prompt, args.model)
    files = result.get("files", [])
    if not isinstance(files, list):
        raise ValueError("Model returned invalid files list.")
    files.extend(ensure_tag_pages(files))
    kept_attachments = prune_unused_attachments(staged_attachments, files)
    written = write_files(files)
    written.extend(path for path in kept_attachments if path not in written)
    write_generated_files_manifest(written)
    write_pr_body(result, written, email, staged_attachments, kept_attachments)
    print(f"Wrote {len(written)} file(s).")
    for path in written:
        print(path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
