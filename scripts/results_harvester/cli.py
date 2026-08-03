#!/usr/bin/env python3
"""Harvest race results and candidate photos for a Dirigo update draft."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

if __package__ in {None, ""}:
    import sys

    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from scripts.results_harvester.fetch import read_source
from scripts.results_harvester.matching import match_results
from scripts.results_harvester.member_roll import load_member_roll
from scripts.results_harvester.parsers import parse_results_source
from scripts.results_harvester.photos import candidate_photos_for_match, parse_gallery


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Compare race results against a privacy-safe Dirigo member roll."
    )
    parser.add_argument("--member-roll", required=True, type=Path, help="CSV with display_name, aliases, tags.")
    parser.add_argument("--results-url", action="append", default=[], help="Race results URL or local HTML file.")
    parser.add_argument("--photo-url", action="append", default=[], help="Photo/gallery URL or local HTML file.")
    parser.add_argument("--race", default="", help="Race name hint for output and photo scoring.")
    parser.add_argument("--date", default="", help="Race date hint, YYYY-MM-DD.")
    parser.add_argument("--out", type=Path, help="Write machine-readable JSON to this path.")
    parser.add_argument("--markdown-out", type=Path, help="Write review Markdown to this path.")
    parser.add_argument("--max-photo-candidates", type=int, default=5)
    return parser.parse_args()


def build_payload(args: argparse.Namespace) -> dict[str, object]:
    members = load_member_roll(args.member_roll)

    rows = []
    result_source_errors: list[str] = []
    for source in args.results_url:
        try:
            source_rows = parse_results_source(read_source(source), source)
            if not source_rows:
                result_source_errors.append(
                    f"{source}: no result rows found. This may be a JavaScript-rendered results page; "
                    "try a CSV export, copied results table saved as CSV/HTML, or a site-specific adapter."
                )
            rows.extend(source_rows)
        except Exception as exc:  # noqa: BLE001 - review artifact should keep going.
            result_source_errors.append(f"{source}: {exc}")

    confirmed, possible, warnings = match_results(rows, members)
    warnings.extend(result_source_errors)

    galleries: list[tuple[str, list[dict[str, str]]]] = []
    photo_source_errors: list[str] = []
    for source in args.photo_url:
        try:
            galleries.append((source, parse_gallery(read_source(source), source)))
        except Exception as exc:  # noqa: BLE001
            photo_source_errors.append(f"{source}: {exc}")
    warnings.extend(photo_source_errors)

    def match_with_photos(match):
        value = match.to_dict()
        value["photo_candidates"] = [
            item.to_dict()
            for item in candidate_photos_for_match(
                match,
                galleries,
                race_hint=args.race,
                limit=args.max_photo_candidates,
            )
        ]
        return value

    return {
        "race": args.race,
        "date": args.date,
        "member_roll": str(args.member_roll),
        "member_count": len(members),
        "results_sources": args.results_url,
        "photo_sources": args.photo_url,
        "parsed_result_rows": len(rows),
        "confirmed_matches": [match_with_photos(match) for match in confirmed],
        "possible_matches": [match_with_photos(match) for match in possible],
        "warnings": warnings,
    }


def markdown_table(matches: list[dict[str, object]]) -> str:
    if not matches:
        return "_None found._\n"
    lines = [
        "| Member | Place | Time | Division | Bib | Reason |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    for item in matches:
        result = item["result"]
        assert isinstance(result, dict)
        lines.append(
            "| {member} | {place} | {time} | {division} | {bib} | {reason} |".format(
                member=item["member"],
                place=result.get("place", ""),
                time=result.get("time", ""),
                division=result.get("division") or result.get("division_place") or "",
                bib=result.get("bib", ""),
                reason=item["reason"],
            )
        )
    return "\n".join(lines) + "\n"


def markdown_photos(matches: list[dict[str, object]]) -> str:
    lines: list[str] = []
    for item in matches:
        photos = item.get("photo_candidates") or []
        if not photos:
            continue
        lines.append(f"### {item['member']}")
        for photo in photos:
            assert isinstance(photo, dict)
            lines.append(
                f"- score {photo['score']}: [{photo['reason']}]({photo['link_url']}) "
                f"from {photo['source_page']}"
            )
    return "\n".join(lines) + ("\n" if lines else "_No scored photo candidates found._\n")


def render_markdown(payload: dict[str, object]) -> str:
    confirmed = payload["confirmed_matches"]
    possible = payload["possible_matches"]
    assert isinstance(confirmed, list)
    assert isinstance(possible, list)

    lines = [
        "# Results Harvest",
        "",
        f"- Race: {payload.get('race') or 'TODO'}",
        f"- Date: {payload.get('date') or 'TODO'}",
        f"- Members loaded: {payload['member_count']}",
        f"- Parsed result rows: {payload['parsed_result_rows']}",
        f"- Results sources: {', '.join(payload['results_sources']) if payload['results_sources'] else 'None'}",
        f"- Photo sources: {', '.join(payload['photo_sources']) if payload['photo_sources'] else 'None'}",
        "",
        "## Confirmed Matches",
        "",
        markdown_table(confirmed),
        "## Possible Matches",
        "",
        markdown_table(possible),
        "## Photo Candidates",
        "",
        markdown_photos(confirmed + possible),
    ]
    warnings = payload.get("warnings") or []
    if warnings:
        lines.extend(["## Warnings", ""])
        lines.extend(f"- {warning}" for warning in warnings)
    return "\n".join(lines).strip() + "\n"


def main() -> int:
    args = parse_args()
    if not args.results_url:
        raise SystemExit("At least one --results-url is required.")

    payload = build_payload(args)

    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if args.markdown_out:
        args.markdown_out.parent.mkdir(parents=True, exist_ok=True)
        args.markdown_out.write_text(render_markdown(payload), encoding="utf-8")

    if not args.out and not args.markdown_out:
        print(json.dumps(payload, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
