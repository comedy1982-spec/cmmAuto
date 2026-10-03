"""전 마켓 전략 스캐너 → 텔레그램 알림.

설정된 거래소(기본 upbit)의 전체 마켓을 주기적으로 스캔해 두 전략을 검사한다.
 - 엔벨로프: 지정 봉에서 가격이 SMA(기간) ± N% 밴드에 닿으면 알림
 - 자동 추세선: 선택한 봉들(시간봉·일봉·주봉 등)마다 피벗 고점/저점을 이은
   추세선을 그려, 현재가가 하락 저항선을 상향 돌파하거나 상승 지지선을
   하향 이탈하면 알림 (규칙은 app/trendline.py)
같은 심볼·봉·전략·방향은 같은 봉에서 한 번만 알린다.

요청 절약: 현재가는 시세 일괄 조회(fetch_tickers) 1회로 받고, 봉 데이터는
심볼·봉별로 캐시해 새 봉이 시작됐을 때만 다시 받는다.

설정(토큰·챗ID·전략 파라미터)은 DB settings 테이블에 저장되어 UI에서 바꿀 수 있다.
"""
from __future__ import annotations

import asyncio
import copy
import json
import logging
import time
from collections import deque

import aiohttp
import ccxt.async_support as ccxt

from .config import Config, ExchangeConfig
from .db import Database
from .trendline import find_trendline

log = logging.getLogger("scanner")

SETTINGS_KEY = "scanner"

SCAN_TIMEFRAMES = ["1m", "3m", "5m", "15m", "30m", "1h", "4h", "1d", "1w"]

DEFAULT_SETTINGS = {
    "enabled": False,
    "exchange": "upbit",
    "sweep_interval_seconds": 30,
    "telegram_token": "",
    "telegram_chat_id": "",
    "envelope": {
        "on": True,
        "timeframe": "3m",
        "period": 20,          # 차트 Envelope 지표와 동일한 SMA 기간
        "percent": 5.0,        # 밴드 폭 ±%
    },
    "trendline": {
        "on": True,
        "timeframes": ["1h", "4h", "1d", "1w"],
        "pivot": 5,            # 피벗 판정 좌우 봉 수
        "lookback": 150,       # 피벗을 찾는 최근 봉 수
    },
}

# 업비트 시세 API는 IP당 초당 10회 수준이라 수집기 몫을 남기고 스캐너는 더 느리게 돈다
MIN_SCANNER_RATELIMIT_MS = 120
MARKETS_TTL = 600         # 전체 마켓 목록 갱신 주기(초)
MAX_FETCH = 200           # 업비트 캔들 1회 요청 최대 개수
MAX_TL_LOOKBACK = 180     # MAX_FETCH 안에 탐색 봉수 + 피벗 여유가 들어가도록
MAX_TL_PIVOT = 10


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


def _tf_ms(tf: str) -> int:
    return ccxt.Exchange.parse_timeframe(tf) * 1000


def merge_settings(saved: dict | None) -> dict:
    """저장된 설정을 기본값 위에 얹는다. 구버전(엔벨로프 평면 키)도 변환."""
    s = copy.deepcopy(DEFAULT_SETTINGS)
    if not saved:
        return s
    for k in ("enabled", "exchange", "sweep_interval_seconds", "telegram_token", "telegram_chat_id"):
        if k in saved:
            s[k] = saved[k]
    # 구버전: {"timeframe", "period", "percent"}가 최상위에 있던 엔벨로프 전용 설정
    for k in ("timeframe", "period", "percent"):
        if k in saved and "envelope" not in saved:
            s["envelope"][k] = saved[k]
    for section in ("envelope", "trendline"):
        if isinstance(saved.get(section), dict):
            s[section].update({k: v for k, v in saved[section].items() if k in s[section]})
    return s


class Scanner:
    def __init__(self, cfg: Config, db: Database):
        self.cfg = cfg
        self.db = db
        self.settings: dict = merge_settings(None)
        self._settings_rev = 0
        self._task: asyncio.Task | None = None
        self._exchange: ccxt.Exchange | None = None
        self._exchange_id: str | None = None
        self._symbols: list[str] = []
        self._symbols_at = 0.0
        self._http: aiohttp.ClientSession | None = None
        # (symbol, tf) → {"candles", "limit", "valid_until"(ms)}
        self._cache: dict[tuple[str, str], dict] = {}
        # (전략, symbol, tf, side) → 마지막으로 알림 보낸 봉 시각(ms). 봉당 1회 중복 방지
        self._fired: dict[tuple[str, str, str, str], int] = {}
        self.recent: deque[dict] = deque(maxlen=200)
        self.status: dict = {
            "running": False,
            "last_sweep_started": None,
            "last_sweep_finished": None,
            "sweep_seconds": None,
            "scanned": 0,
            "symbol_count": 0,
            "fetches": 0,
            "alerts_sent": 0,
            "last_error": None,
            "telegram_error": None,
        }

    # ----- 수명주기 -----

    async def start(self) -> None:
        raw = await self.db.get_setting(SETTINGS_KEY)
        if raw:
            try:
                self.settings = merge_settings(json.loads(raw))
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
        s = copy.deepcopy(self.settings)
        if "enabled" in data:
            s["enabled"] = bool(data["enabled"])
        if "exchange" in data:
            ex = str(data["exchange"])
            if ex not in self.cfg.exchanges:
                raise ValueError(f"설정에 없는 거래소: {ex}")
            s["exchange"] = ex
        if "sweep_interval_seconds" in data:
            iv = int(data["sweep_interval_seconds"])
            if not 10 <= iv <= 3600:
                raise ValueError("스캔 주기는 10~3600초 사이여야 합니다")
            s["sweep_interval_seconds"] = iv
        if "telegram_token" in data:
            s["telegram_token"] = str(data["telegram_token"]).strip()[:100]
        if "telegram_chat_id" in data:
            s["telegram_chat_id"] = str(data["telegram_chat_id"]).strip()[:50]

        env = data.get("envelope")
        if isinstance(env, dict):
            e = s["envelope"]
            if "on" in env:
                e["on"] = bool(env["on"])
            if "timeframe" in env:
                if env["timeframe"] not in SCAN_TIMEFRAMES:
                    raise ValueError(f"지원하지 않는 봉: {env['timeframe']}")
                e["timeframe"] = env["timeframe"]
            if "period" in env:
                p = int(env["period"])
                if not 2 <= p <= MAX_FETCH - 5:
                    raise ValueError(f"엔벨로프 기간은 2~{MAX_FETCH - 5} 사이여야 합니다")
                e["period"] = p
            if "percent" in env:
                pct = float(env["percent"])
                if not 0.1 <= pct <= 50:
                    raise ValueError("엔벨로프 %는 0.1~50 사이여야 합니다")
                e["percent"] = pct

        tl = data.get("trendline")
        if isinstance(tl, dict):
            t = s["trendline"]
            if "on" in tl:
                t["on"] = bool(tl["on"])
            if "timeframes" in tl:
                tfs = [x for x in SCAN_TIMEFRAMES if x in set(tl["timeframes"] or [])]
                t["timeframes"] = tfs
            if "pivot" in tl:
                pv = int(tl["pivot"])
                if not 2 <= pv <= MAX_TL_PIVOT:
                    raise ValueError(f"피벗은 2~{MAX_TL_PIVOT} 사이여야 합니다")
                t["pivot"] = pv
            if "lookback" in tl:
                lb = int(tl["lookback"])
                if not 30 <= lb <= MAX_TL_LOOKBACK:
                    raise ValueError(f"추세선 탐색 봉수는 30~{MAX_TL_LOOKBACK} 사이여야 합니다")
                t["lookback"] = lb
            if t["on"] and not t["timeframes"]:
                raise ValueError("추세선 감시 봉을 하나 이상 선택해 주세요")

        if s["enabled"]:
            if not s["telegram_token"] or not s["telegram_chat_id"]:
                raise ValueError("스캐너를 켜려면 텔레그램 봇 토큰과 챗 ID를 먼저 입력해 주세요")
            if not s["envelope"]["on"] and not s["trendline"]["on"]:
                raise ValueError("엔벨로프나 추세선 중 하나 이상 켜 주세요")

        if s["exchange"] != self.settings["exchange"]:
            self._cache.clear()
            self._symbols_at = 0.0
        self.settings = s
        self._settings_rev += 1
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

    def _strategy_summary(self) -> str:
        s = self.settings
        parts = []
        if s["envelope"]["on"]:
            e = s["envelope"]
            parts.append(f"엔벨로프 {e['timeframe']}봉 ±{e['percent']:g}%")
        if s["trendline"]["on"]:
            parts.append(f"추세선 돌파 {'/'.join(s['trendline']['timeframes'])}")
        return " · ".join(parts) or "켜진 전략 없음"

    async def send_test(self) -> str | None:
        """테스트 메시지를 보내고, 실패하면 오류 메시지를 반환한다."""
        try:
            await self._telegram_send(
                "✅ cmmAuto 테스트 메시지\n"
                f"{self.settings['exchange']} 전 마켓 감시 준비 완료\n{self._strategy_summary()}"
            )
            self.status["telegram_error"] = None
            return None
        except Exception as e:  # noqa: BLE001 - 오류 내용을 UI로 그대로 전달
            self.status["telegram_error"] = str(e)
            return str(e)

    # ----- 데이터 -----

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

    def _tf_needs(self) -> dict[str, int]:
        """이번 스캔에서 볼 봉 → 필요한 캔들 개수."""
        s = self.settings
        needs: dict[str, int] = {}
        if s["envelope"]["on"]:
            e = s["envelope"]
            needs[e["timeframe"]] = e["period"] + 2
        if s["trendline"]["on"]:
            t = s["trendline"]
            n = min(MAX_FETCH, t["lookback"] + t["pivot"] * 2 + 5)
            for tf in t["timeframes"]:
                needs[tf] = max(needs.get(tf, 0), n)
        ex = self._exchange
        if ex is not None and ex.timeframes:
            needs = {tf: n for tf, n in needs.items() if tf in ex.timeframes}
        return needs

    async def _candles(self, ex: ccxt.Exchange, symbol: str, tf: str, limit: int) -> list | None:
        """캐시된 캔들. 새 봉이 시작됐거나 더 많은 개수가 필요하면 다시 받는다."""
        key = (symbol, tf)
        entry = self._cache.get(key)
        now = ex.milliseconds()
        if entry and entry["limit"] >= limit and now < entry["valid_until"]:
            return entry["candles"]
        candles = await ex.fetch_ohlcv(symbol, tf, limit=limit)
        self.status["fetches"] += 1
        if not candles:
            return None
        tf_ms = _tf_ms(tf)
        last_ts = candles[-1][0]
        # 마지막 봉 시각 기준 격자에서 다음 봉 경계까지 유효
        valid_until = last_ts + ((now - last_ts) // tf_ms + 1) * tf_ms
        self._cache[key] = {"candles": candles, "limit": limit, "valid_until": valid_until}
        return candles

    @staticmethod
    def _with_live_price(candles: list, tf_ms: int, now: int, price: float | None) -> list:
        """캐시 캔들의 진행 중 봉에 현재가를 반영한 사본 (캐시는 건드리지 않음)."""
        if price is None:
            return candles
        last = candles[-1]
        cur_start = last[0] + ((now - last[0]) // tf_ms) * tf_ms
        if cur_start == last[0]:
            patched = [last[0], last[1], max(last[2], price), min(last[3], price), price, last[5]]
            return candles[:-1] + [patched]
        # 거래가 없어 진행 중 봉이 아직 없으면 현재가로 새 봉을 만든다
        return candles + [[cur_start, price, price, price, price, 0]]

    # ----- 전략 -----

    def _once(self, strategy: str, symbol: str, tf: str, side: str, bar_ts: int) -> bool:
        key = (strategy, symbol, tf, side)
        if self._fired.get(key) == bar_ts:
            return False
        self._fired[key] = bar_ts
        return True

    def _alert(self, symbol: str, tf: str, strategy: str, side: str, price: float,
               level: float, label: str, detail: str = "") -> dict:
        return {
            "time": int(time.time()),
            "exchange": self.settings["exchange"],
            "symbol": symbol,
            "timeframe": tf,
            "strategy": strategy,
            "side": side,
            "price": price,
            "level": level,
            "label": label,
            "detail": detail,
        }

    def _check_envelope(self, symbol: str, tf: str, c: list) -> list[dict]:
        e = self.settings["envelope"]
        period = e["period"]
        pct = e["percent"] / 100.0
        if len(c) < period:
            return []
        basis = sum(row[4] for row in c[-period:]) / period
        upper, lower = basis * (1 + pct), basis * (1 - pct)
        bar_ts, high, low, close = int(c[-1][0]), c[-1][2], c[-1][3], c[-1][4]
        out = []
        if high >= upper and self._once("env", symbol, tf, "upper", bar_ts):
            out.append(self._alert(symbol, tf, "envelope", "up", close, upper,
                                   f"엔벨로프 상단(+{e['percent']:g}%) 터치"))
        if low <= lower and self._once("env", symbol, tf, "lower", bar_ts):
            out.append(self._alert(symbol, tf, "envelope", "down", close, lower,
                                   f"엔벨로프 하단(-{e['percent']:g}%) 터치"))
        return out

    def _bar_label(self, ts_ms: int, tf: str) -> str:
        t = time.gmtime(ts_ms / 1000 + self.cfg.timezone_offset_hours * 3600)
        if tf in ("1d", "1w"):
            return time.strftime("%y/%m/%d", t)
        return time.strftime("%m/%d %H:%M", t)

    def _check_trendline(self, symbol: str, tf: str, c: list) -> list[dict]:
        t = self.settings["trendline"]
        pivot, lookback = t["pivot"], t["lookback"]
        end = len(c) - 1
        if end < pivot * 2 + 3:
            return []
        price = c[end][4]
        bar_ts = int(c[end][0])
        out = []
        res = find_trendline(c, end, pivot, lookback, "res")
        if res and price > res.value and self._once("tl", symbol, tf, "up", bar_ts):
            detail = f"고점 {self._bar_label(c[res.i1][0], tf)} → {self._bar_label(c[res.i2][0], tf)} 연결"
            out.append(self._alert(symbol, tf, "trendline", "up", price, res.value,
                                   "하락 추세선 상향 돌파", detail))
        sup = find_trendline(c, end, pivot, lookback, "sup")
        if sup and price < sup.value and self._once("tl", symbol, tf, "down", bar_ts):
            detail = f"저점 {self._bar_label(c[sup.i1][0], tf)} → {self._bar_label(c[sup.i2][0], tf)} 연결"
            out.append(self._alert(symbol, tf, "trendline", "down", price, sup.value,
                                   "상승 추세선 하향 이탈", detail))
        return out

    def _alert_text(self, a: dict) -> str:
        if a["strategy"] == "trendline":
            icon = "🚀" if a["side"] == "up" else "⚠️"
            level_name = "추세선"
        else:
            icon = "📈" if a["side"] == "up" else "📉"
            level_name = "밴드"
        tz = self.cfg.timezone_offset_hours * 3600
        t = time.strftime("%H:%M:%S", time.gmtime(a["time"] + tz))
        lines = [
            f"{icon} {a['exchange']} {a['symbol']} · {a['timeframe']}봉",
            a["label"],
            f"현재가 {_fmt_price(a['price'])} · {level_name} {_fmt_price(a['level'])}",
        ]
        if a["detail"]:
            lines.append(a["detail"])
        lines.append(f"{t} KST")
        return "\n".join(lines)

    # ----- 스캔 루프 -----

    async def _sweep(self) -> None:
        st = self.status
        st["last_sweep_started"] = int(time.time())
        started = time.monotonic()
        rev = self._settings_rev
        ex = await self._get_exchange()
        symbols = await self._get_symbols(ex)
        needs = self._tf_needs()
        s = self.settings

        errors = 0
        last_err: str | None = None
        prices: dict[str, float] = {}
        try:
            tickers = await ex.fetch_tickers(symbols)
            prices = {sym: t["last"] for sym, t in tickers.items() if t.get("last")}
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001 - 현재가 없이 캔들만으로도 판정 가능
            errors += 1
            last_err = f"시세 일괄 조회: {type(e).__name__}: {e}"

        scanned = 0
        for symbol in symbols:
            # 스캔 도중 설정이 바뀌거나 꺼지면 즉시 중단
            if self._settings_rev != rev or not s["enabled"]:
                break
            ok = False
            for tf, limit in needs.items():
                try:
                    cached = await self._candles(ex, symbol, tf, limit)
                except asyncio.CancelledError:
                    raise
                except Exception as e:  # noqa: BLE001 - 개별 심볼 실패는 건너뛴다
                    errors += 1
                    last_err = f"{symbol} {tf}: {type(e).__name__}: {e}"
                    continue
                if not cached:
                    continue
                ok = True
                c = self._with_live_price(cached, _tf_ms(tf), ex.milliseconds(), prices.get(symbol))
                alerts: list[dict] = []
                if s["envelope"]["on"] and tf == s["envelope"]["timeframe"]:
                    alerts += self._check_envelope(symbol, tf, c)
                if s["trendline"]["on"] and tf in s["trendline"]["timeframes"]:
                    alerts += self._check_trendline(symbol, tf, c)
                for alert in alerts:
                    self.recent.appendleft(alert)
                    st["alerts_sent"] += 1
                    try:
                        await self._telegram_send(self._alert_text(alert))
                        st["telegram_error"] = None
                    except Exception as e:  # noqa: BLE001 - 전송 실패해도 스캔은 계속
                        st["telegram_error"] = str(e)
                        log.warning("텔레그램 전송 실패: %s", e)
            scanned += ok

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
