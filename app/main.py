"""FastAPI 서버: 수집기 구동 + 캔들 REST API + 정적 프론트엔드."""
from __future__ import annotations

import logging
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .collector import Collector
from .config import load_config
from .db import Database

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")

STATIC_DIR = Path(__file__).parent / "static"


@asynccontextmanager
async def lifespan(app: FastAPI):
    cfg = load_config()
    db = Database(cfg.database)
    await db.init()
    collector = Collector(cfg, db)
    await collector.start()
    app.state.cfg = cfg
    app.state.db = db
    app.state.collector = collector
    yield
    await collector.stop()
    await db.close()


app = FastAPI(title="cmmAuto Chart Viewer", lifespan=lifespan)


@app.get("/api/meta")
async def meta():
    cfg = app.state.cfg
    collector: Collector = app.state.collector
    return {
        "timeframes": cfg.timeframes,
        "poll_interval_seconds": cfg.poll_interval_seconds,
        "exchanges": {
            ex_id: {
                "symbols": ex_cfg.symbols,
                "status": collector.status.get(ex_id, {}),
            }
            for ex_id, ex_cfg in cfg.exchanges.items()
        },
        "server_time": int(time.time()),
    }


@app.get("/api/candles")
async def candles(
    exchange: str,
    symbol: str,
    timeframe: str,
    limit: int = Query(500, ge=1, le=5000),
    before: int | None = Query(None, description="이 유닉스 시각(초) 이전 캔들만 반환"),
):
    cfg = app.state.cfg
    if exchange not in cfg.exchanges:
        raise HTTPException(404, f"설정에 없는 거래소: {exchange}")
    rows = await app.state.db.get_candles(
        exchange, symbol, timeframe,
        limit=limit,
        before_ms=before * 1000 if before is not None else None,
    )
    return {"exchange": exchange, "symbol": symbol, "timeframe": timeframe, "candles": rows}


@app.get("/api/markets")
async def markets(exchange: str):
    """해당 거래소에서 거래 가능한 전체 심볼 목록 (config에 추가할 때 참고용)."""
    collector: Collector = app.state.collector
    ex = collector.exchanges.get(exchange)
    if ex is None:
        raise HTTPException(404, f"활성화되지 않은 거래소: {exchange}")
    try:
        await ex.load_markets()
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"마켓 조회 실패: {e}") from e
    return {"exchange": exchange, "symbols": sorted(ex.markets.keys())}


@app.get("/")
async def index():
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
