"""엔벨로프 밴드 스캐너.

설정된 거래소(기본 upbit)의 전체 마켓을 주기적으로 스캔해, 각 심볼의
지정 봉(기본 3m)에서 가격이 SMA(기간) ± N% 엔벨로프 밴드에 닿으면
텔레그램으로 알림을 보낸다. 같은 심볼·방향은 같은 봉에서 한 번만 알린다.

설정(토큰·챗ID·밴드 % 등)은 DB settings 테이블에 저장되어 UI에서 바꿀 수 있다.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from collections import deque

import aiohttp
import ccxt.async_support as ccxt

from .config import Config, ExchangeConfig
from .db import Database

log = logging.getLogger("scanner")

SETTINGS_KEY = "scanner"

DEFAULT_SETTINGS = {
    "enabled": False,
    "exchange": "upbit",
    "timeframe": "3m",
    "period": 20,              # 엔벨로프 SMA 기간 (차트 지표와 동일 정의)
    "percent": 5.0,            # 밴드 폭 ±%
    "sweep_interval_seconds": 60,
    "telegram_token": "",
    "telegram_chat_id": "",
}

# 업비트 시세 API는 IP당 초당 10회 수준이라 수집기 몫을 남기고 스캐너는 더 느리게 돈다
MIN_SCANNER_RATELIMIT_MS = 120
MARKETS_TTL = 600  # 전체 마켓 목록 갱신 주기(초)


def market_matches(ex_cfg: ExchangeConfig, market: dict) -> bool:
    """config의 quote/market_type 필터에 맞는 활성 마켓인지."""
    if market.get("active") is False:
        return False
    if ex_cfg.quote and market.get("quote") != ex_cfg.quote:
        return False
    if ex_cfg.market_type == "spot" and not market.get("spot"):
        return False
    if ex_cfg.market_type == "swap":
        if not market.get("swap"):
            return False
        if market.get("linear") is False:
            return False
    return True


def _fmt_price(v: float) -> str:
    if v >= 1000:
        return f"{v:,.0f}"
    if v >= 1:
        return f"{v:,.2f}"
    return f"{v:.6f}".rstrip("0").rstrip(".")


class Scanner:
    def __init__(self, cfg: Config, db: Database):
        self.cfg = cfg
        self.db = db
        self.settings: dict = dict(DEFAULT_SETTINGS)
        self._settings_rev = 0
        self._task: asyncio.Task | None = None
        self._exchange: ccxt.Exchange | None = None
        self._exchange_id: str | None = None
        self._symbols: list[str] = []
        self._symbols_at = 0.0
        self._http: aiohttp.ClientSession | None = None
        # (symbol, side) → 마지막으로 알림 보낸 봉 시각(ms). 봉당 1회 중복 방지
        self._fired: dict[tuple[str, str], int] = {}
        self.recent: deque[dict] = deque(maxlen=200)
        self.status: dict = {
            "running": False,
            "last_sweep_started": None,
            "last_sweep_finished": None,
            "sweep_seconds": None,
            "scanned": 0,
            "symbol_count": 0,
            "alerts_sent": 0,
            "last_error": None,
            "telegram_error": None,
        }

    # ----- 수명주기 -----

    async def start(self) -> None:
        raw = await self.db.get_setting(SETTINGS_KEY)
        if raw:
            try:
                saved = json.loads(raw)
                self.settings.update({k: saved[k] for k in DEFAULT_SETTINGS if k in saved})
            except Exception as e:  # noqa: BLE001 - 저장분이 깨져도 기본값으로 기동
                log.warning("저장된 스캐너 설정 파싱 실패, 기본값 사용: %s", e)
        self._task = asyncio.create_task(self._run(), name="scanner")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)
        if self._exchange:
            await asyncio.gather(self._exchange.close(), return_exceptions=True)
        if self._http:
            await self._http.close()

    # ----- 설정 -----

    async def apply_settings(self, data: dict) -> None:
        """UI에서 온 설정을 검증·저장하고 즉시 반영한다. 잘못되면 ValueError."""
        s = dict(self.settings)
        if "enabled" in data:
            s["enabled"] = bool(data["enabled"])
        if "exchange" in data:
            ex = str(data["exchange"])
            if ex not in self.cfg.exchanges:
                raise ValueError(f"설정에 없는 거래소: {ex}")
            s["exchange"] = ex
        if "timeframe" in data:
            tf = str(data["timeframe"]).strip()
            if not tf or len(tf) > 5:
                raise ValueError(f"잘못된 타임프레임: {tf}")
            s["timeframe"] = tf
        if "period" in data:
            p = int(data["period"])
            if not 2 <= p <= 400:
                raise ValueError("기간은 2~400 사이여야 합니다")
            s["period"] = p
        if "percent" in data:
            pct = float(data["percent"])
            if not 0.1 <= pct <= 50:
                raise ValueError("밴드 %는 0.1~50 사이여야 합니다")
            s["percent"] = pct
        if "sweep_interval_seconds" in data:
            iv = int(data["sweep_interval_seconds"])
            if not 15 <= iv <= 3600:
                raise ValueError("스캔 주기는 15~3600초 사이여야 합니다")
            s["sweep_interval_seconds"] = iv
        if "telegram_token" in data:
            s["telegram_token"] = str(data["telegram_token"]).strip()[:100]
        if "telegram_chat_id" in data:
            s["telegram_chat_id"] = str(data["telegram_chat_id"]).strip()[:50]

        if s["enabled"] and (not s["telegram_token"] or not s["telegram_chat_id"]):
            raise ValueError("스캐너를 켜려면 텔레그램 봇 토큰과 챗 ID를 먼저 입력해 주세요")

        self.settings = s
        self._settings_rev += 1
        self._symbols_at = 0.0  # 거래소가 바뀌었을 수 있으니 마켓 목록 재조회
        await self.db.save_setting(SETTINGS_KEY, json.dumps(s, ensure_ascii=False))

    # ----- 텔레그램 -----

    async def _telegram_send(self, text: str) -> None:
        token = self.settings["telegram_token"]
        chat_id = self.settings["telegram_chat_id"]
        if not token or not chat_id:
            raise RuntimeError("텔레그램 봇 토큰/챗 ID가 설정되지 않았습니다")
        if self._http is None or self._http.closed:
            self._http = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10))
        url = f"https://api.telegram.org/bot{token}/sendMessage"
        async with self._http.post(url, json={"chat_id": chat_id, "text": text}) as res:
            body = await res.json(content_type=None)
            if not body.get("ok"):
                raise RuntimeError(body.get("description") or f"HTTP {res.status}")

    async def send_test(self) -> str | None:
        """테스트 메시지를 보내고, 실패하면 오류 메시지를 반환한다."""
        s = self.settings
        try:
            await self._telegram_send(
                "✅ cmmAuto 테스트 메시지\n"
                f"{s['exchange']} 전 마켓 · {s['timeframe']}봉 엔벨로프 ±{s['percent']:g}% 감시 준비 완료"
            )
            self.status["telegram_error"] = None
            return None
        except Exception as e:  # noqa: BLE001 - 오류 내용을 UI로 그대로 전달
            self.status["telegram_error"] = str(e)
            return str(e)

    # ----- 스캔 -----

    async def _get_exchange(self) -> ccxt.Exchange:
        ex_id = self.settings["exchange"]
        if self._exchange is not None and self._exchange_id == ex_id:
            return self._exchange
        if self._exchange is not None:
            await asyncio.gather(self._exchange.close(), return_exceptions=True)
            self._exchange = None
        ex_cfg = self.cfg.exchanges[ex_id]
        klass = getattr(ccxt, ex_cfg.ccxt_id or ex_id, None)
        if klass is None:
            raise RuntimeError(f"ccxt 미지원 거래소: {ex_cfg.ccxt_id or ex_id}")
        ex = klass({"enableRateLimit": True, **ex_cfg.options})
        ex.rateLimit = max(ex.rateLimit, MIN_SCANNER_RATELIMIT_MS)
        self._exchange = ex
        self._exchange_id = ex_id
        return ex

    async def _get_symbols(self, ex: ccxt.Exchange) -> list[str]:
        if self._symbols and time.time() - self._symbols_at < MARKETS_TTL:
            return self._symbols
        ex_cfg = self.cfg.exchanges[self.settings["exchange"]]
        await ex.load_markets(reload=bool(self._symbols))
        self._symbols = sorted(s for s, m in ex.markets.items() if market_matches(ex_cfg, m))
        self._symbols_at = time.time()
        self.status["symbol_count"] = len(self._symbols)
        return self._symbols

    def _check_bands(self, symbol: str, candles: list[list[float]]) -> list[dict]:
        """마지막(진행 중) 봉이 밴드에 닿았는지 검사해 알림 목록을 만든다."""
        period = self.settings["period"]
        pct = self.settings["percent"] / 100.0
        if len(candles) < period:
            return []
        closes = [c[4] for c in candles[-period:]]
        basis = sum(closes) / period
        upper = basis * (1 + pct)
        lower = basis * (1 - pct)
        bar = candles[-1]
        bar_ts, high, low, close = int(bar[0]), bar[2], bar[3], bar[4]

        hits = []
        for side, band, touched in (
            ("upper", upper, high >= upper),
            ("lower", lower, low <= lower),
        ):
            if not touched:
                continue
            if self._fired.get((symbol, side)) == bar_ts:
                continue  # 같은 봉에서는 한 번만
            self._fired[(symbol, side)] = bar_ts
            hits.append({
                "time": int(time.time()),
                "bar_time": bar_ts // 1000,
                "exchange": self.settings["exchange"],
                "symbol": symbol,
                "timeframe": self.settings["timeframe"],
                "side": side,
                "price": close,
                "band": band,
                "percent": self.settings["percent"],
            })
        return hits

    def _alert_text(self, a: dict) -> str:
        side_txt = "상단" if a["side"] == "upper" else "하단"
        arrow = "📈" if a["side"] == "upper" else "📉"
        sign = "+" if a["side"] == "upper" else "-"
        tz = self.cfg.timezone_offset_hours * 3600
        t = time.strftime("%H:%M:%S", time.gmtime(a["time"] + tz))
        return (
            f"{arrow} {a['exchange']} {a['symbol']} · {a['timeframe']}봉\n"
            f"엔벨로프 {side_txt}({sign}{a['percent']:g}%) 터치\n"
            f"현재가 {_fmt_price(a['price'])} · 밴드 {_fmt_price(a['band'])}\n"
            f"{t} KST"
        )

    async def _sweep(self) -> None:
        st = self.status
        st["last_sweep_started"] = int(time.time())
        started = time.monotonic()
        rev = self._settings_rev
        ex = await self._get_exchange()
        symbols = await self._get_symbols(ex)
        tf = self.settings["timeframe"]
        limit = self.settings["period"] + 1

        scanned = 0
        errors = 0
        last_err: str | None = None
        for symbol in symbols:
            # 스캔 도중 설정이 바뀌거나 꺼지면 즉시 중단
            if self._settings_rev != rev or not self.settings["enabled"]:
                break
            try:
                candles = await ex.fetch_ohlcv(symbol, tf, limit=limit)
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001 - 개별 심볼 실패는 건너뛴다
                errors += 1
                last_err = f"{symbol}: {type(e).__name__}: {e}"
                continue
            scanned += 1
            for alert in self._check_bands(symbol, candles):
                self.recent.appendleft(alert)
                st["alerts_sent"] += 1
                try:
                    await self._telegram_send(self._alert_text(alert))
                    st["telegram_error"] = None
                except Exception as e:  # noqa: BLE001 - 전송 실패해도 스캔은 계속
                    st["telegram_error"] = str(e)
                    log.warning("텔레그램 전송 실패: %s", e)

        st["scanned"] = scanned
        st["last_error"] = last_err if errors else None
        st["last_sweep_finished"] = int(time.time())
        st["sweep_seconds"] = round(time.monotonic() - started, 1)

    async def _run(self) -> None:
        while True:
            if not self.settings["enabled"]:
                self.status["running"] = False
                await asyncio.sleep(2)
                continue
            self.status["running"] = True
            rev = self._settings_rev
            try:
                await self._sweep()
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001 - 스캐너는 죽지 않고 재시도
                self.status["last_error"] = f"{type(e).__name__}: {e}"
                log.warning("스캔 실패: %s", e)
                await asyncio.sleep(10)
                continue
            # 다음 스캔까지 대기 (설정이 바뀌면 바로 다음 루프로)
            elapsed = self.status["sweep_seconds"] or 0
            wait = max(5.0, self.settings["sweep_interval_seconds"] - elapsed)
            step_until = time.monotonic() + wait
            while time.monotonic() < step_until:
                if self._settings_rev != rev or not self.settings["enabled"]:
                    break
                await asyncio.sleep(1)
