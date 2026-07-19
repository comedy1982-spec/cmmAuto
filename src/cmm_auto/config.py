"""환경변수 기반 설정 로드."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv


@dataclass(frozen=True)
class Settings:
    coupang_access_key: str = ""
    coupang_secret_key: str = ""
    anthropic_api_key: str = ""
    db_path: Path = field(default_factory=lambda: Path("data/cmm_auto.db"))
    output_dir: Path = field(default_factory=lambda: Path("output"))

    def require_coupang_keys(self) -> None:
        if not self.coupang_access_key or not self.coupang_secret_key:
            raise RuntimeError(
                "쿠팡 파트너스 API 키가 설정되지 않았습니다. "
                ".env 파일에 COUPANG_ACCESS_KEY, COUPANG_SECRET_KEY를 넣어주세요. "
                "(.env.example 참고)"
            )


def load_settings(env_file: str | os.PathLike | None = None) -> Settings:
    load_dotenv(env_file)
    return Settings(
        coupang_access_key=os.getenv("COUPANG_ACCESS_KEY", ""),
        coupang_secret_key=os.getenv("COUPANG_SECRET_KEY", ""),
        anthropic_api_key=os.getenv("ANTHROPIC_API_KEY", ""),
        db_path=Path(os.getenv("CMM_DB_PATH", "data/cmm_auto.db")),
        output_dir=Path(os.getenv("CMM_OUTPUT_DIR", "output")),
    )
