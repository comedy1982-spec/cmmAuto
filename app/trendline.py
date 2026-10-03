"""자동 추세선 (피벗 연결) — app/static/indicators.js의 findTrendline과 동일한 규칙.

캔들 형식: ccxt OHLCV [[ts, open, high, low, close, volume], ...] (오름차순)

규칙
 - 피벗 고점: 좌우 L봉보다 높은 봉 (왼쪽은 같아도 탈락, 오른쪽은 같으면 허용)
 - 저항선(res): 최근 피벗 고점 P2와, 그보다 높은 이전 피벗 고점 P1을 잇는 하락 추세선
 - 지지선(sup): 최근 피벗 저점 P2와, 그보다 낮은 이전 피벗 저점 P1을 잇는 상승 추세선
 - 유효성: P1~P2 사이 봉의 몸통(시가·종가)이 선을 넘지 않고,
          P2 이후 마감 봉의 종가도 선을 넘지 않아야 한다 (꼬리는 허용)
 - P2는 최근 피벗부터 최대 3개, P1은 P2에 가까운 피벗부터 시도해 처음 유효한 선을 쓴다
 - 판정 봉(end) = 보통 진행 중인 마지막 봉. 그 이전 봉들만으로 선을 만든다
"""
from __future__ import annotations

from dataclasses import dataclass

O, H, L_, C = 1, 2, 3, 4
MAX_P2_CANDIDATES = 3


@dataclass
class Trendline:
    i1: int
    p1: float
    i2: int
    p2: float
    slope: float
    value: float  # 판정 봉(end)에서의 추세선 가격

    def value_at(self, i: int) -> float:
        return self.p1 + self.slope * (i - self.i1)


def _is_pivot(c: list, j: int, n: int, high: bool) -> bool:
    col = H if high else L_
    v = c[j][col]
    for t in range(j - n, j + n + 1):
        if t == j:
            continue
        w = c[t][col]
        if high:
            if (w >= v) if t < j else (w > v):
                return False
        else:
            if (w <= v) if t < j else (w < v):
                return False
    return True


def find_trendline(c: list, end: int, pivot: int, lookback: int, kind: str) -> Trendline | None:
    """c[0..end-1]을 마감 봉으로 보고 kind('res'|'sup') 추세선을 찾는다."""
    is_res = kind == "res"
    col = H if is_res else L_
    start = max(pivot, end - lookback)
    piv = [j for j in range(end - 1 - pivot, start - 1, -1) if _is_pivot(c, j, pivot, is_res)]

    for a in range(min(MAX_P2_CANDIDATES, len(piv))):
        j2 = piv[a]
        p2 = c[j2][col]
        for b in range(a + 1, len(piv)):
            j1 = piv[b]
            p1 = c[j1][col]
            if not (p1 > p2 if is_res else p1 < p2):
                continue
            slope = (p2 - p1) / (j2 - j1)
            ok = True
            for k in range(j1 + 1, end):
                if k == j2:
                    continue
                lv = p1 + slope * (k - j1)
                bar = c[k]
                if k < j2:
                    x = max(bar[O], bar[C]) if is_res else min(bar[O], bar[C])
                else:
                    x = bar[C]
                if (x > lv) if is_res else (x < lv):
                    ok = False
                    break
            if not ok:
                continue
            value = p1 + slope * (end - j1)
            if value <= 0:
                continue
            return Trendline(j1, p1, j2, p2, slope, value)
    return None
