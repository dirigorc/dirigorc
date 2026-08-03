"""Find candidate event photos from public gallery pages."""

from __future__ import annotations

import re
from dataclasses import dataclass
from html.parser import HTMLParser
from urllib.parse import urljoin

from scripts.results_harvester.matching import Match
from scripts.results_harvester.member_roll import normalize_name


IMAGE_EXT_RE = re.compile(r"\.(avif|gif|jpe?g|png|webp)(\?|#|$)", re.IGNORECASE)


@dataclass
class PhotoCandidate:
    source_page: str
    image_url: str
    link_url: str
    alt: str
    score: int
    reason: str

    def to_dict(self) -> dict[str, object]:
        return {
            "source_page": self.source_page,
            "image_url": self.image_url,
            "link_url": self.link_url,
            "alt": self.alt,
            "score": self.score,
            "reason": self.reason,
        }


class GalleryParser(HTMLParser):
    def __init__(self, base_url: str) -> None:
        super().__init__()
        self.base_url = base_url
        self.images: list[dict[str, str]] = []
        self._link_stack: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attrs_dict = {key.lower(): value or "" for key, value in attrs}
        if tag == "a":
            href = attrs_dict.get("href", "")
            self._link_stack.append(urljoin(self.base_url, href) if href else "")
        elif tag == "img":
            src = attrs_dict.get("src") or attrs_dict.get("data-src") or attrs_dict.get("data-original")
            if not src:
                return
            image_url = urljoin(self.base_url, src)
            link_url = self._link_stack[-1] if self._link_stack else image_url
            self.images.append(
                {
                    "image_url": image_url,
                    "link_url": link_url,
                    "alt": attrs_dict.get("alt", ""),
                }
            )

    def handle_endtag(self, tag: str) -> None:
        if tag == "a" and self._link_stack:
            self._link_stack.pop()


def parse_gallery(html_text: str, source_page: str) -> list[dict[str, str]]:
    parser = GalleryParser(source_page)
    parser.feed(html_text)
    candidates: list[dict[str, str]] = []
    seen: set[str] = set()
    for image in parser.images:
        image_url = image["image_url"]
        if image_url in seen:
            continue
        if not IMAGE_EXT_RE.search(image_url):
            continue
        seen.add(image_url)
        candidates.append(image)
    return candidates


def score_photo(image: dict[str, str], match: Match, race_hint: str = "") -> tuple[int, str]:
    haystack = normalize_name(" ".join([image.get("image_url", ""), image.get("link_url", ""), image.get("alt", "")]))
    reasons: list[str] = []
    score = 0

    name_tokens = [token for token in normalize_name(match.member.display_name).split() if len(token) > 2]
    matched_name_tokens = [token for token in name_tokens if token in haystack]
    if matched_name_tokens:
        score += 4 * len(matched_name_tokens)
        reasons.append("name token")

    if match.row.bib and match.row.bib in haystack:
        score += 6
        reasons.append("bib")

    if "dirigo" in haystack:
        score += 3
        reasons.append("Dirigo")

    race_tokens = [token for token in normalize_name(race_hint).split() if len(token) > 4]
    if race_tokens and any(token in haystack for token in race_tokens):
        score += 1
        reasons.append("race token")

    return score, ", ".join(reasons) if reasons else "low signal"


def candidate_photos_for_match(
    match: Match,
    galleries: list[tuple[str, list[dict[str, str]]]],
    race_hint: str = "",
    limit: int = 5,
) -> list[PhotoCandidate]:
    scored: list[PhotoCandidate] = []
    for source_page, images in galleries:
        for image in images:
            score, reason = score_photo(image, match, race_hint=race_hint)
            if score < 4:
                continue
            scored.append(
                PhotoCandidate(
                    source_page=source_page,
                    image_url=image["image_url"],
                    link_url=image.get("link_url", image["image_url"]),
                    alt=image.get("alt", ""),
                    score=score,
                    reason=reason,
                )
            )
    scored.sort(key=lambda item: item.score, reverse=True)
    return scored[:limit]
