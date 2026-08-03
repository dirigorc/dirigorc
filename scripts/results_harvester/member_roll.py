"""Load a privacy-safe Dirigo member matching roll.

The input CSV should be a purpose-built export with names and aliases only.
Do not feed the treasurer's live dues spreadsheet to this helper.
"""

from __future__ import annotations

import csv
import re
import unicodedata
from dataclasses import dataclass
from pathlib import Path


ALIAS_SPLIT_RE = re.compile(r"\s*[;|]\s*")
NON_NAME_RE = re.compile(r"[^a-z0-9 ]+")
HEADER_RE = re.compile(r"[^a-z0-9]+")


@dataclass(frozen=True)
class Member:
    display_name: str
    aliases: tuple[str, ...]
    tags: tuple[str, ...] = ()


def normalize_name(value: str) -> str:
    """Normalize names for conservative matching."""

    decomposed = unicodedata.normalize("NFKD", value or "")
    ascii_value = "".join(char for char in decomposed if not unicodedata.combining(char))
    lowered = ascii_value.lower().replace(".", " ")
    cleaned = NON_NAME_RE.sub(" ", lowered)
    return " ".join(cleaned.split())


def name_parts(value: str) -> tuple[str, ...]:
    normalized = normalize_name(value)
    if not normalized:
        return ()
    return tuple(normalized.split())


def alias_values(display_name: str, aliases: str | None) -> tuple[str, ...]:
    values = [display_name]
    if aliases:
        values.extend(part for part in ALIAS_SPLIT_RE.split(aliases) if part.strip())
    seen: set[str] = set()
    deduped: list[str] = []
    for value in values:
        normalized = normalize_name(value)
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        deduped.append(value.strip())
    return tuple(deduped)


def normalize_header(value: str | None) -> str:
    normalized = normalize_name(value or "")
    return HEADER_RE.sub("_", normalized).strip("_")


def row_value(row: dict[str, str], *names: str) -> str:
    for name in names:
        value = row.get(name)
        if value:
            return value.strip()
    return ""


def display_name_from_row(row: dict[str, str], index: int) -> str:
    display_name = row_value(row, "display_name", "name", "member_name", "full_name")
    if display_name:
        return display_name

    first_name = row_value(row, "first_name", "first", "given_name")
    last_name = row_value(row, "last_name", "last", "surname", "family_name")
    if first_name and last_name:
        return f"{first_name} {last_name}"

    raise ValueError(
        "Member roll CSV needs either display_name or first_name/last_name columns "
        f"(missing in row {index})."
    )


def is_blank_row(row: dict[str, str]) -> bool:
    return not any((value or "").strip() for value in row.values())


def load_member_roll(path: Path) -> list[Member]:
    with path.open(newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle)
        fieldnames = [normalize_header(name) for name in (reader.fieldnames or [])]
        reader.fieldnames = fieldnames
        if not fieldnames:
            raise ValueError("Member roll CSV has no header row.")

        members: list[Member] = []
        for index, row in enumerate(reader, start=2):
            if is_blank_row(row):
                continue
            display_name = display_name_from_row(row, index)
            tags = tuple(
                part.strip()
                for part in ALIAS_SPLIT_RE.split(row_value(row, "tags", "tag"))
                if part.strip()
            ) or (display_name,)
            members.append(
                Member(
                    display_name=display_name,
                    aliases=alias_values(display_name, row_value(row, "aliases", "alias", "nicknames")),
                    tags=tags,
                )
            )
    return members
