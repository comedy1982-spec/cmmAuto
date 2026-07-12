"""ccxt 기반 OHLCV 수집기.

거래소별로 하나의 asyncio 태스크를 돌리며, 두 종류의 대상을 수집한다:
 1) config에 적힌 기본 심볼 × 타임프레임 (상시)
 2) 동적 심볼: 사용자가 차트에서 열어본 (심볼, 타임프레임) — 마지막 조회 후
    dynamic_ttl_seconds 동안 계속 갱신하다가 안 보면 자동으로 수집 중단

최초 수집 시에는 backfill_candles 개수만큼 과거 데이터를 페이지 단위로 채운다.
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
        # 동적 수집 대상: (ex_id, symbol, tf) → 마지막 조회 시각
        self.dynamic: dict[tuple[str, str, str], float] = {}
        # 프론트엔드 상태 표시용: {exchange: {ok, last_sync, last_error, timeframes}}
        self.status: dict[str, dict] = {}

    async def start(self) -> None:
        for ex_id, ex_cfg in self.cfg.exchanges.items():
            ccxt_id = ex_cfg.ccxt_id or ex_id
            klass = getattr(ccxt, ccxt_id, None)
            if klass is None:
                log.error("알 수 없는 거래소 id: %s (ccxt 미지원)", ccxt_id)
                self.status[ex_id] = {"ok": False, "last_error": f"unknown exchange id: {ccxt_id}"}
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
                "market_type": ex_cfg.market_type,
                "quote": ex_cfg.quote,
            }
            self.tasks.append(asyncio.create_task(self._run_exchange(ex_id), name=f"collector:{ex_id}"))

    async def stop(self) -> None:
        for t in self.tasks:
            t.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        await asyncio.gather(*(ex.close() for ex in self.exchanges.values()), return_exceptions=True)

    def _tf_supported(self, exchange: ccxt.Exchange, tf: str) -> bool:
        return not exchange.timeframes or tf in exchange.timeframes

    def _jobs(self, ex_id: str) -> list[tuple[str, str]]:
        """이번 사이클에 수집할 (symbol, tf) 목록: 기본 + 살아있는 동적 대상."""
        exchange = self.exchanges[ex_id]
        jobs: list[tuple[str, str]] = []
        seen: set[tuple[str, str]] = set()
        for symbol in self.cfg.exchanges[ex_id].symbols:
            for tf in self.status[ex_id]["timeframes"]:
                jobs.append((symbol, tf))
                seen.add((symbol, tf))
        cutoff = time.time() - self.cfg.dynamic_ttl_seconds
        for (dex, symbol, tf), last in list(self.dynamic.items()):
            if dex != ex_id:
                continue
            if last < cutoff:
                del self.dynamic[(dex, symbol, tf)]
                continue
            if (symbol, tf) not in seen and self._tf_supported(exchange, tf):
                jobs.append((symbol, tf))
                seen.add((symbol, tf))
        return jobs

    async def _run_exchange(self, ex_id: str) -> None:
        exchange = self.exchanges[ex_id]
        st = self.status[ex_id]

        while True:
            for symbol, tf in self._jobs(ex_id):
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

    async def ensure_fresh(self, ex_id: str, symbol: str, tf: str) -> None:
        """차트가 열어본 (심볼, 봉)을 동적 수집 대상으로 등록하고,
        데이터가 없거나 오래됐으면 즉시 한 번 동기화한다 (API 경로에서 호출)."""
        exchange = self.exchanges.get(ex_id)
        if exchange is None or not self._tf_supported(exchange, tf):
            return
        self.dynamic[(ex_id, symbol, tf)] = time.time()
        try:
            tf_ms = exchange.parse_timeframe(tf) * 1000
            last = await self.db.last_timestamp(ex_id, symbol, tf)
            if last is None or last < exchange.milliseconds() - 2 * tf_ms:
                await self._sync_one(exchange, ex_id, symbol, tf)
        except Exception as e:  # noqa: BLE001 - 조회 실패 시 저장분만 반환
            log.warning("[%s] %s %s 온디맨드 수집 실패: %s", ex_id, symbol, tf, e)

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
