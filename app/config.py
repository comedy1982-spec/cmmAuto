"""config.json 로더. 파일이 없으면 기본값으로 새로 만든다 (exe 단독 배포 지원)."""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

from .paths import BASE_DIR

ROOT = BASE_DIR

DEFAULT_CONFIG = {
    "database": "data/candles.db",
    "poll_interval_seconds": 5,
    "live_refresh_seconds": 10,
    "backfill_candles": 1500,
    "dynamic_ttl_seconds": 900,
    "timezone_offset_hours": 9,
    "timeframes": ["1m", "5m", "15m", "1h", "4h", "1d"],
    "exchanges": {
        "upbit": {
            "quote": "KRW",
            "market_type": "spot",
            "symbols": ["BTC/KRW", "ETH/KRW", "XRP/KRW"],
        },
        "binance": {
            "ccxt_id": "binanceusdm",
            "quote": "USDT",
            "market_type": "swap",
            "symbols": ["BTC/USDT:USDT", "ETH/USDT:USDT", "SOL/USDT:USDT", "XRP/USDT:USDT"],
        },
        "bybit": {
            "quote": "USDT",
            "market_type": "swap",
            "symbols": ["BTC/USDT:USDT", "ETH/USDT:USDT"],
        },
    },
}


@dataclass
class ExchangeConfig:
    symbols: list[str] = field(default_factory=list)  # 상시 수집하는 기본 심볼
    options: dict = field(default_factory=dict)       # ccxt 생성자 옵션
    ccxt_id: str | None = None                        # ccxt 거래소 id (없으면 키 그대로)
    quote: str | None = None                          # 마켓 목록 필터: 결제 통화 (KRW, USDT …)
    market_type: str | None = None                    # 마켓 목록 필터: spot | swap


@dataclass
class Config:
    database: Path
    poll_interval_seconds: int
    live_refresh_seconds: int
    backfill_candles: int
    dynamic_ttl_seconds: int
    timezone_offset_hours: int
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
            ccxt_id=spec.get("ccxt_id"),
            quote=spec.get("quote"),
            market_type=spec.get("market_type"),
        )
        for ex_id, spec in raw.get("exchanges", {}).items()
    }

    db_path = Path(raw.get("database", "data/candles.db"))
    if not db_path.is_absolute():
        db_path = ROOT / db_path

    return Config(
        database=db_path,
        poll_interval_seconds=int(raw.get("poll_interval_seconds", 5)),
        live_refresh_seconds=int(raw.get("live_refresh_seconds", 10)),
        backfill_candles=int(raw.get("backfill_candles", 1500)),
        dynamic_ttl_seconds=int(raw.get("dynamic_ttl_seconds", 900)),
        timezone_offset_hours=int(raw.get("timezone_offset_hours", 9)),
        timeframes=list(raw.get("timeframes", ["1m", "1h", "1d"])),
        exchanges=exchanges,
    )
