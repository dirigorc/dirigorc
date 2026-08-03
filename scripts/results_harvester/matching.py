"""Match parsed race results against a member roll."""

from __future__ import annotations

import difflib
from dataclasses import dataclass, field

from scripts.results_harvester.member_roll import Member, name_parts, normalize_name
from scripts.results_harvester.parsers import ResultRow, result_to_dict


@dataclass
class Match:
    member: Member
    row: ResultRow
    confidence: str
    reason: str
    score: float
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, object]:
        return {
            "member": self.member.display_name,
            "confidence": self.confidence,
            "reason": self.reason,
            "score": round(self.score, 3),
            "tags": list(self.member.tags),
            "result": result_to_dict(self.row),
            "warnings": self.warnings,
        }


def build_alias_index(members: list[Member]) -> tuple[dict[str, Member], list[str]]:
    index: dict[str, Member] = {}
    warnings: list[str] = []
    for member in members:
        for alias in member.aliases:
            normalized = normalize_name(alias)
            if not normalized:
                continue
            if normalized in index and index[normalized] != member:
                warnings.append(
                    f"Alias {alias!r} is shared by {index[normalized].display_name} and {member.display_name}."
                )
                continue
            index[normalized] = member
    return index, warnings


def surname_initial_match(row_name: str, member: Member) -> bool:
    row_parts = name_parts(row_name)
    if len(row_parts) < 2:
        return False
    row_first, row_last = row_parts[0], row_parts[-1]
    for alias in member.aliases:
        alias_parts = name_parts(alias)
        if len(alias_parts) < 2:
            continue
        if row_last == alias_parts[-1] and row_first[:1] == alias_parts[0][:1]:
            return True
    return False


def best_fuzzy_member(row_name: str, members: list[Member]) -> tuple[Member | None, float]:
    normalized = normalize_name(row_name)
    best_member: Member | None = None
    best_score = 0.0
    for member in members:
        for alias in member.aliases:
            score = difflib.SequenceMatcher(None, normalized, normalize_name(alias)).ratio()
            if score > best_score:
                best_score = score
                best_member = member
    return best_member, best_score


def match_results(rows: list[ResultRow], members: list[Member]) -> tuple[list[Match], list[Match], list[str]]:
    alias_index, warnings = build_alias_index(members)
    confirmed: list[Match] = []
    possible: list[Match] = []

    matched_keys: set[tuple[str, str, str]] = set()
    for row in rows:
        normalized = normalize_name(row.name)
        key = (normalized, row.time, row.place)
        if not normalized or key in matched_keys:
            continue

        team_signal = "dirigo" in normalize_name(row.team)
        exact_member = alias_index.get(normalized)
        if exact_member:
            confirmed.append(
                Match(
                    member=exact_member,
                    row=row,
                    confidence="confirmed",
                    reason="exact name or alias match" + (" plus Dirigo team field" if team_signal else ""),
                    score=1.0,
                )
            )
            matched_keys.add(key)
            continue

        surname_member = next((member for member in members if surname_initial_match(row.name, member)), None)
        if surname_member:
            possible.append(
                Match(
                    member=surname_member,
                    row=row,
                    confidence="possible",
                    reason="surname and first-initial match; review before publishing",
                    score=0.86,
                )
            )
            matched_keys.add(key)
            continue

        fuzzy_member, fuzzy_score = best_fuzzy_member(row.name, members)
        if fuzzy_member and fuzzy_score >= 0.92:
            possible.append(
                Match(
                    member=fuzzy_member,
                    row=row,
                    confidence="possible",
                    reason="high fuzzy name similarity; review before publishing",
                    score=fuzzy_score,
                )
            )
            matched_keys.add(key)
            continue

        if team_signal:
            warnings.append(
                f"Result row for {row.name!r} has a Dirigo team field but no member-roll match."
            )

    return confirmed, possible, warnings

