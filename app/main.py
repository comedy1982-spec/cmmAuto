"""FastAPI 서버: 수집기 구동 + 캔들 REST API + 정적 프론트엔드."""
from __future__ import annotations

import json
import logging
import time
from contextlib import asynccontextmanager

from fastapi import Body, FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .collector import Collector
from .config import load_config
from .db import Database
from .paths import BUNDLE_DIR
from .resample import parse_tf, pick_source, resample, source_fetch_limit

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")

STATIC_DIR = BUNDLE_DIR / "app" / "static"


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


@app.middleware("http")
async def no_stale_static(request, call_next):
    """업데이트(git pull) 후 브라우저가 옛 JS/CSS를 쓰지 않도록 항상 재검증시킨다.
    no-cache는 '캐시 금지'가 아니라 '사용 전 서버에 변경 여부 확인'이라 304로 가볍다."""
    response = await call_next(request)
    path = request.url.path
    if path == "/" or path.startswith("/static"):
        response.headers["Cache-Control"] = "no-cache"
    return response


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
    before_ms = before * 1000 if before is not None else None

    # 1) 수집 대상 봉이면 저장된 캔들을 그대로 반환
    rows: list[dict] = []
    if timeframe in cfg.timeframes:
        rows = await app.state.db.get_candles(exchange, symbol, timeframe, limit=limit, before_ms=before_ms)

    # 2) 그 외(주봉·월봉·사용자 지정 봉 등)는 저장 데이터에서 리샘플링
    if not rows:
        if parse_tf(timeframe) is None:
            raise HTTPException(400, f"잘못된 타임프레임: {timeframe} (예: 3m, 2h, 1d, 1w, 1M)")
        src = pick_source(cfg.timeframes, timeframe)
        if src is not None:
            fetch = source_fetch_limit(src, timeframe, limit)
            src_rows = await app.state.db.get_candles(exchange, symbol, src, limit=fetch, before_ms=before_ms)
            res = resample(src_rows, timeframe)
            # 소스를 상한까지 읽었다면 가장 오래된 버킷은 앞부분이 잘렸을 수 있어 제외
            if len(src_rows) >= fetch and len(res) > 1:
                res = res[1:]
            rows = res[-limit:]
        elif timeframe not in cfg.timeframes:
            raise HTTPException(400, f"리샘플 소스가 없는 타임프레임: {timeframe}")

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


# ----- 차트 레이아웃 프리셋 (트레이딩뷰의 '차트 레이아웃 저장'에 해당) -----

MAX_LAYOUT_NAME = 60
MAX_LAYOUT_BYTES = 64 * 1024


def _check_layout_name(name: str) -> str:
    name = name.strip()
    if not name or len(name) > MAX_LAYOUT_NAME:
        raise HTTPException(400, f"레이아웃 이름은 1~{MAX_LAYOUT_NAME}자여야 합니다")
    return name


@app.get("/api/layouts")
async def list_layouts():
    return {"layouts": await app.state.db.list_layouts()}


@app.get("/api/layouts/{name}")
async def get_layout(name: str):
    data = await app.state.db.get_layout(_check_layout_name(name))
    if data is None:
        raise HTTPException(404, f"저장된 레이아웃 없음: {name}")
    return {"name": name, "data": json.loads(data)}


@app.put("/api/layouts/{name}")
async def save_layout(name: str, data: dict = Body(...)):
    name = _check_layout_name(name)
    payload = json.dumps(data, ensure_ascii=False)
    if len(payload.encode()) > MAX_LAYOUT_BYTES:
        raise HTTPException(413, "레이아웃 데이터가 너무 큽니다")
    await app.state.db.save_layout(name, payload)
    return {"ok": True, "name": name}


@app.delete("/api/layouts/{name}")
async def delete_layout(name: str):
    deleted = await app.state.db.delete_layout(_check_layout_name(name))
    if not deleted:
        raise HTTPException(404, f"저장된 레이아웃 없음: {name}")
    return {"ok": True}


@app.get("/")
async def index():
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
