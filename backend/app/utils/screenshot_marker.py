import re
from typing import List, Tuple


def extract_screenshot_timestamps(markdown: str) -> List[Tuple[str, int]]:
    pattern = r"(?<![\w-])(\*?Screenshot-(?:\[(\d+:\d{2}(?::\d{2})?)\]|(\d+:\d{2}(?::\d{2})?))(?![\w:]|\.\d)\*?)"
    results: List[Tuple[str, int]] = []
    for match in re.finditer(pattern, markdown):
        parts = [int(part) for part in (match.group(2) or match.group(3)).split(':')]
        if parts[-1] >= 60 or (len(parts) == 3 and parts[-2] >= 60):
            continue
        total_seconds = parts[0] * 60 + parts[1] if len(parts) == 2 else parts[0] * 3600 + parts[1] * 60 + parts[2]
        results.append((match.group(1), total_seconds))
    return results
