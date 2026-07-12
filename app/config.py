"""config.json 로더. 파일이 없으면 기본값으로 새로 만든다 (exe 단독 배포 지원)."""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

from .paths import BASE_DIR

ROOT = BASE_DIR

DEFAULT_CONFIG = {
    "database": "data/candles.db",
    "poll_interval_seconds": 20,
    "backfill_candles": 1500,
    "timeframes": ["1m", "5m", "15m", "1h", "4h", "1d"],
    "exchanges": {
        "binance": {"symbols": ["BTC/USDT", "ETH/USDT", "SOL/USDT", "XRP/USDT"]},
        "upbit": {"symbols": ["BTC/KRW", "ETH/KRW", "XRP/KRW"]},
        "bybit": {"symbols": ["BTC/USDT", "ETH/USDT"]},
    },
}


@dataclass
class ExchangeConfig:
    symbols: list[str] = field(default_factory=list)
    options: dict = field(default_factory=dict)


@dataclass
class Config:
    database: Path
    poll_interval_seconds: int
    backfill_candles: int
    timeframes: list[str]
    exchanges: dict[str, ExchangeConfig]


def load_config(path: Path | None = None) -> Config:
    path = path or ROOT / "config.json"
    if not path.exists():
        path.write_text(json.dumps(DEFAULT_CONFIG, ensure_ascii=False, indent=2), encoding="utf-8")
    raw = json.loads(path.read_text(encoding="utf-8"))

    exchanges = {
        ex_id: ExchangeConfig(
            symbols=list(spec.get("symbols", [])),
            options=dict(spec.get("options", {})),
        )
        for ex_id, spec in raw.get("exchanges", {}).items()
    }

    db_path = Path(raw.get("database", "data/candles.db"))
    if not db_path.is_absolute():
        db_path = ROOT / db_path

    return Config(
        database=db_path,
        poll_interval_seconds=int(raw.get("poll_interval_seconds", 20)),
        backfill_candles=int(raw.get("backfill_candles", 1500)),
        timeframes=list(raw.get("timeframes", ["1m", "1h", "1d"])),
        exchanges=exchanges,
    )
