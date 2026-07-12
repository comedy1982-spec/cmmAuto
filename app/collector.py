"""ccxt 기반 OHLCV 수집기.

거래소별로 하나의 asyncio 태스크를 돌리며, 설정된 심볼 × 타임프레임 조합을
순회하면서 마지막 저장 시점 이후의 캔들을 받아 SQLite에 upsert 한다.
최초 실행 시에는 backfill_candles 개수만큼 과거 데이터를 페이지 단위로 채운다.
"""
from __future__ import annotations

import asyncio
import logging
import time

import ccxt.async_support as ccxt

from .config import Config
from .db import Database

log = logging.getLogger("collector")

FETCH_PAGE_LIMIT = 1000   # 한 번의 fetch_ohlcv 요청 최대 개수 (거래소가 더 낮게 자를 수 있음)
MAX_BACKFILL_PAGES = 30   # 백필 시 무한 루프 방지용 페이지 상한


class Collector:
    def __init__(self, cfg: Config, db: Database):
        self.cfg = cfg
        self.db = db
        self.exchanges: dict[str, ccxt.Exchange] = {}
        self.tasks: list[asyncio.Task] = []
        # 프론트엔드 상태 표시용: {exchange: {ok, last_sync, last_error, timeframes}}
        self.status: dict[str, dict] = {}

    async def start(self) -> None:
        for ex_id, ex_cfg in self.cfg.exchanges.items():
            klass = getattr(ccxt, ex_id, None)
            if klass is None:
                log.error("알 수 없는 거래소 id: %s (ccxt 미지원)", ex_id)
                self.status[ex_id] = {"ok": False, "last_error": f"unknown exchange id: {ex_id}"}
                continue
            exchange = klass({"enableRateLimit": True, **ex_cfg.options})
            self.exchanges[ex_id] = exchange
            supported = [tf for tf in self.cfg.timeframes if tf in (exchange.timeframes or {})]
            self.status[ex_id] = {
                "ok": True,
                "last_sync": None,
                "last_error": None,
                "timeframes": supported,
                "symbols": ex_cfg.symbols,
            }
            self.tasks.append(asyncio.create_task(self._run_exchange(ex_id), name=f"collector:{ex_id}"))

    async def stop(self) -> None:
        for t in self.tasks:
            t.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        await asyncio.gather(*(ex.close() for ex in self.exchanges.values()), return_exceptions=True)

    async def _run_exchange(self, ex_id: str) -> None:
        exchange = self.exchanges[ex_id]
        st = self.status[ex_id]
        symbols = self.cfg.exchanges[ex_id].symbols
        timeframes = st["timeframes"]

        while True:
            for symbol in symbols:
                for tf in timeframes:
                    try:
                        await self._sync_one(exchange, ex_id, symbol, tf)
                        st["last_error"] = None
                    except asyncio.CancelledError:
                        raise
                    except Exception as e:  # noqa: BLE001 - 개별 실패가 전체를 죽이면 안 됨
                        st["last_error"] = f"{symbol} {tf}: {type(e).__name__}: {e}"
                        log.warning("[%s] %s %s 수집 실패: %s", ex_id, symbol, tf, e)
            st["last_sync"] = int(time.time())
            await asyncio.sleep(self.cfg.poll_interval_seconds)

    async def _sync_one(self, exchange: ccxt.Exchange, ex_id: str, symbol: str, tf: str) -> None:
        tf_ms = exchange.parse_timeframe(tf) * 1000
        last = await self.db.last_timestamp(ex_id, symbol, tf)

        if last is None:
            # 최초 백필: 목표 개수만큼 과거부터 앞으로 페이지 단위로 채운다
            since = exchange.milliseconds() - self.cfg.backfill_candles * tf_ms
        else:
            # 마지막 캔들은 저장 당시 미완성(진행 중)이었을 수 있으므로 다시 받는다
            since = last

        for _ in range(MAX_BACKFILL_PAGES):
            batch = await exchange.fetch_ohlcv(symbol, tf, since=since, limit=FETCH_PAGE_LIMIT)
            if not batch:
                break
            await self.db.upsert_candles(ex_id, symbol, tf, batch)
            newest = batch[-1][0]
            # 마지막 캔들이 현재 진행 중인 봉까지 도달했으면 종료
            if newest >= exchange.milliseconds() - tf_ms:
                break
            if newest <= since and len(batch) == 1:
                break
            since = newest + tf_ms
