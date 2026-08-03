"""Generic race-results HTML parsing.

This is intentionally site-agnostic. We start by extracting tables and normalize
common results column names. Site-specific adapters can be added later for
RunSignUp, Race Roster, All Sports Events, UltraSignup, and timing vendors.
"""

from __future__ import annotations

import html
import csv
import io
import re
from dataclasses import dataclass, field
from html.parser import HTMLParser


SPACE_RE = re.compile(r"\s+")


@dataclass
class ResultRow:
    source_url: str
    raw: dict[str, str]
    name: str = ""
    time: str = ""
    place: str = ""
    division: str = ""
    division_place: str = ""
    gender_place: str = ""
    bib: str = ""
    team: str = ""
    event: str = ""


class TableParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.tables: list[list[list[str]]] = []
        self._table: list[list[str]] | None = None
        self._row: list[str] | None = None
        self._cell_parts: list[str] | None = None
        self._in_cell = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "table":
            self._table = []
        elif tag == "tr" and self._table is not None:
            self._row = []
        elif tag in {"td", "th"} and self._row is not None:
            self._cell_parts = []
            self._in_cell = True

    def handle_data(self, data: str) -> None:
        if self._in_cell and self._cell_parts is not None:
            self._cell_parts.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag in {"td", "th"} and self._cell_parts is not None and self._row is not None:
            self._row.append(clean_text(" ".join(self._cell_parts)))
            self._cell_parts = None
            self._in_cell = False
        elif tag == "tr" and self._row is not None and self._table is not None:
            if any(cell for cell in self._row):
                self._table.append(self._row)
            self._row = None
        elif tag == "table" and self._table is not None:
            if self._table:
                self.tables.append(self._table)
            self._table = None


def clean_text(value: str) -> str:
    return SPACE_RE.sub(" ", html.unescape(value or "")).strip()


def normalize_header(value: str) -> str:
    cleaned = clean_text(value).lower()
    cleaned = re.sub(r"[^a-z0-9]+", " ", cleaned).strip()
    if cleaned in {"name", "athlete", "runner", "participant", "full name"}:
        return "name"
    if cleaned in {"time", "finish time", "gun time", "chip time", "net time", "mark"}:
        return "time"
    if cleaned in {"place", "pl", "overall", "overall place", "oa", "pos"}:
        return "place"
    if cleaned in {"division", "age group", "age group division", "age"}:
        return "division"
    if cleaned in {"division place", "div place", "age group place", "ag place", "division pl"}:
        return "division_place"
    if cleaned in {"gender place", "sex place", "gender pl", "sex pl"}:
        return "gender_place"
    if cleaned in {"bib", "bib number", "bib no", "no"}:
        return "bib"
    if cleaned in {"team", "club", "organization"}:
        return "team"
    if cleaned in {"event", "race", "distance"}:
        return "event"
    return cleaned.replace(" ", "_")


def rows_from_table(table: list[list[str]], source_url: str) -> list[ResultRow]:
    if len(table) < 2:
        return []

    headers = [normalize_header(cell) for cell in table[0]]
    if "name" not in headers:
        return []

    rows: list[ResultRow] = []
    for cells in table[1:]:
        if len(cells) < 2:
            continue
        raw = {
            headers[index]: clean_text(cell)
            for index, cell in enumerate(cells[: len(headers)])
            if headers[index]
        }
        name = raw.get("name", "")
        if not name:
            continue
        rows.append(
            ResultRow(
                source_url=source_url,
                raw=raw,
                name=name,
                time=raw.get("time", ""),
                place=raw.get("place", ""),
                division=raw.get("division", ""),
                division_place=raw.get("division_place", ""),
                gender_place=raw.get("gender_place", ""),
                bib=raw.get("bib", ""),
                team=raw.get("team", ""),
                event=raw.get("event", ""),
            )
        )
    return rows


def parse_results_html(html_text: str, source_url: str) -> list[ResultRow]:
    parser = TableParser()
    parser.feed(html_text)

    rows: list[ResultRow] = []
    seen: set[tuple[str, str, str, str]] = set()
    for table in parser.tables:
        for row in rows_from_table(table, source_url):
            key = (row.name.lower(), row.time, row.place, row.event.lower())
            if key in seen:
                continue
            seen.add(key)
            rows.append(row)
    return rows


def parse_results_csv(csv_text: str, source_url: str) -> list[ResultRow]:
    handle = io.StringIO(csv_text)
    reader = csv.DictReader(handle)
    if not reader.fieldnames:
        return []
    normalized_headers = [normalize_header(header) for header in reader.fieldnames]
    reader.fieldnames = normalized_headers

    rows: list[ResultRow] = []
    seen: set[tuple[str, str, str, str]] = set()
    for raw_row in reader:
        raw = {key: clean_text(value or "") for key, value in raw_row.items() if key}
        name = raw.get("name") or raw.get("athlete") or raw.get("runner") or raw.get("participant") or ""
        if not name:
            continue
        row = ResultRow(
            source_url=source_url,
            raw=raw,
            name=name,
            time=raw.get("time", ""),
            place=raw.get("place", ""),
            division=raw.get("division", ""),
            division_place=raw.get("division_place", ""),
            gender_place=raw.get("gender_place", ""),
            bib=raw.get("bib", ""),
            team=raw.get("team", ""),
            event=raw.get("event", ""),
        )
        key = (row.name.lower(), row.time, row.place, row.event.lower())
        if key in seen:
            continue
        seen.add(key)
        rows.append(row)
    return rows


def parse_results_source(text: str, source_url: str) -> list[ResultRow]:
    stripped = text.lstrip()
    first_line = stripped.splitlines()[0] if stripped.splitlines() else ""
    if source_url.lower().split("?")[0].endswith(".csv") or (
        "<html" not in stripped[:500].lower() and "," in first_line
    ):
        return parse_results_csv(text, source_url)
    return parse_results_html(text, source_url)


def result_to_dict(row: ResultRow) -> dict[str, str | dict[str, str]]:
    return {
        "source_url": row.source_url,
        "name": row.name,
        "place": row.place,
        "time": row.time,
        "division": row.division,
        "division_place": row.division_place,
        "gender_place": row.gender_place,
        "bib": row.bib,
        "team": row.team,
        "event": row.event,
        "raw": row.raw,
    }
