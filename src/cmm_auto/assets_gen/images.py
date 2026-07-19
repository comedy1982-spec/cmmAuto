"""상품 이미지 다운로드 (파트너스 API가 제공하는 이미지 URL 사용)."""
from __future__ import annotations

from pathlib import Path

import requests


def download_image(url: str, out_path: Path, timeout: int = 20) -> Path:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    resp = requests.get(url, timeout=timeout, headers={"User-Agent": "Mozilla/5.0"})
    resp.raise_for_status()
    out_path.write_bytes(resp.content)
    return out_path
