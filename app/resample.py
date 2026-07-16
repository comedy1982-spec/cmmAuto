"""저장된 캔들을 더 큰 타임프레임으로 리샘플링(집계)한다.

수집기는 config의 기본 봉(1m, 1h, 1d 등)만 모으고, 그 외의 봉(3m, 2h, 1w, 1M,
사용자 지정 등)은 요청 시 이 모듈이 저장 데이터에서 만들어낸다.

타임프레임 표기: <숫자><단위>, 단위는 m(분) h(시간) d(일) w(주) M(월).
주봉은 월요일 시작(트레이딩뷰 기본), 월봉은 달력 월 기준. 시각은 모두 UTC.
"""
from __future__ import annotations

import re
from datetime import datetime, timezone

TF_RE = re.compile(r"^(\d+)([mhdwM])$")
SEC = {"m": 60, "h": 3600, "d": 86400}
# 소스 필요량 추정용 상한(주/월은 실제 일수가 가변이라 넉넉히 잡는다)
SPAN_SEC = {**SEC, "w": 7 * 86400, "M": 31 * 86400}

MAX_SOURCE_ROWS = 60_000  # 한 번의 리샘플 요청이 읽는 소스 캔들 상한


def parse_tf(tf: str) -> tuple[int, str] | None:
    m = TF_RE.match(tf)
    if not m:
        return None
    n = int(m.group(1))
    return (n, m.group(2)) if n >= 1 else None


def tf_seconds(tf: str) -> int | None:
    """고정 길이 봉(m/h/d)의 초. 주/월은 가변이므로 None."""
    p = parse_tf(tf)
    if not p:
        return None
    n, u = p
    return n * SEC[u] if u in SEC else None


def pick_source(available: list[str], tf: str) -> str | None:
    """tf를 만들 수 있는 가장 큰(효율적인) 소스 타임프레임을 고른다."""
    p = parse_tf(tf)
    if not p:
        return None
    n, u = p
    if u in ("w", "M"):
        return "1d" if "1d" in available else None
    target = n * SEC[u]
    best, best_s = None, 0
    for a in available:
        s = tf_seconds(a)
        if s and a != tf and s <= target and target % s == 0 and s > best_s:
            best, best_s = a, s
    return best


def _bucket_key(t: int, n: int, u: str, tz_off: int) -> int:
    """tz_off(초)만큼 이동한 현지 시간 기준으로 버킷 인덱스를 계산한다."""
    lt = t + tz_off
    if u in ("m", "h"):
        return lt // (n * SEC[u])
    d = lt // 86400
    if u == "d":
        return d // n
    if u == "w":
        # 1970-01-01은 목요일: +3일 보정으로 월요일 시작 주 인덱스를 만든다
        return ((d + 3) // 7) // n
    dt = datetime.fromtimestamp(lt, tz=timezone.utc)
    # _bucket_start와 짝을 맞추기 위해 1970년 기준 월 인덱스를 쓴다
    return ((dt.year - 1970) * 12 + dt.month - 1) // n


def _bucket_start(key: int, n: int, u: str, tz_off: int) -> int:
    """버킷 시작 시각(UTC 초). 현지 기준 경계를 UTC로 되돌린다."""
    if u in ("m", "h"):
        return key * n * SEC[u] - tz_off
    if u == "d":
        return key * n * 86400 - tz_off
    if u == "w":
        return (key * n * 7 - 3) * 86400 - tz_off
    months = key * n
    local = int(datetime(1970 + months // 12, months % 12 + 1, 1, tzinfo=timezone.utc).timestamp())
    return local - tz_off


def resample(rows: list[dict], tf: str, tz_off: int = 0) -> list[dict]:
    """오름차순 캔들(dict, time은 초)을 tf 버킷으로 집계한다.
    tz_off(초)를 주면 일/주/월 등 버킷 경계가 그 시간대 기준으로 정렬된다."""
    p = parse_tf(tf)
    if not p:
        return []
    n, u = p
    out: list[dict] = []
    cur_key = None
    cur: dict | None = None
    for r in rows:
        k = _bucket_key(r["time"], n, u, tz_off)
        if k != cur_key:
            if cur:
                out.append(cur)
            cur_key = k
            cur = {
                "time": _bucket_start(k, n, u, tz_off),
                "open": r["open"], "high": r["high"],
                "low": r["low"], "close": r["close"],
                "volume": r["volume"],
            }
        else:
            cur["high"] = max(cur["high"], r["high"])
            cur["low"] = min(cur["low"], r["low"])
            cur["close"] = r["close"]
            cur["volume"] += r["volume"]
    if cur:
        out.append(cur)
    return out


def source_fetch_limit(src: str, tf: str, want: int) -> int:
    """want개의 tf 캔들을 만들기 위해 읽어야 할 소스 캔들 수(여유 포함)."""
    p = parse_tf(tf)
    src_sec = tf_seconds(src)
    if not p or not src_sec:
        return MAX_SOURCE_ROWS
    n, u = p
    factor = max(1, (n * SPAN_SEC[u]) // src_sec)
    return min(MAX_SOURCE_ROWS, want * factor + factor)
