"""Fetch or read race result and gallery sources."""

from __future__ import annotations

import urllib.request
from pathlib import Path


USER_AGENT = "DirigoRCResultsHarvester/0.1 (+https://dirigorc.com/)"


def read_source(source: str, timeout: int = 25) -> str:
    """Read a URL or local file path as text."""

    possible_path = Path(source)
    if possible_path.exists():
        return possible_path.read_text(encoding="utf-8", errors="replace")

    request = urllib.request.Request(source, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        content_type = response.headers.get_content_charset() or "utf-8"
        return response.read().decode(content_type, errors="replace")

