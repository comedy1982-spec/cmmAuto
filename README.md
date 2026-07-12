# cmmAuto — 암호화폐 캔들 차트 뷰어

여러 암호화폐 거래소의 분봉·시간봉·일봉(OHLCV) 데이터를 **일정 주기로 자동 수집**해서
로컬 SQLite에 쌓고, 브라우저에서 **트레이딩뷰 스타일 차트**(lightweight-charts)로
보여주는 프로그램입니다.

- 거래소: [ccxt](https://github.com/ccxt/ccxt) 기반 — 바이낸스, 업비트, 바이비트 등 **100개 이상** 지원
- 타임프레임: `1m` `5m` `15m` `1h` `4h` `1d` (설정으로 변경 가능)
- 수집: 서버 시작 시 과거 데이터 백필 → 이후 주기적으로 최신 캔들 증분 수집
- 차트: 캔들 + 거래량, 십자선 OHLC 범례, 왼쪽으로 스크롤하면 과거 데이터 자동 로드,
  5초 주기 실시간 갱신

## 실행 방법

```bash
# 1. 의존성 설치 (Python 3.10+)
pip install -r requirements.txt

# 2. 서버 실행
python run.py            # 기본: http://127.0.0.1:8000
python run.py --port 9000
```

브라우저에서 <http://127.0.0.1:8000> 을 열면 됩니다.
서버가 뜨는 순간부터 백그라운드 수집기가 돌기 시작하고, 최초 실행 시에는
심볼·타임프레임당 과거 1,500개 캔들을 채웁니다(수 분 소요될 수 있음).

## 설정 (`config.json`)

```json
{
  "database": "data/candles.db",
  "poll_interval_seconds": 20,
  "backfill_candles": 1500,
  "timeframes": ["1m", "5m", "15m", "1h", "4h", "1d"],
  "exchanges": {
    "binance": { "symbols": ["BTC/USDT", "ETH/USDT"] },
    "upbit":   { "symbols": ["BTC/KRW"] }
  }
}
```

| 항목 | 설명 |
|---|---|
| `poll_interval_seconds` | 심볼 전체를 한 바퀴 수집한 뒤 쉬는 시간(초) |
| `backfill_candles` | 최초 실행 시 채울 과거 캔들 개수 |
| `timeframes` | 수집할 봉 종류. 거래소가 지원하지 않는 봉은 자동으로 건너뜀 |
| `exchanges` | ccxt 거래소 id → 심볼 목록. id는 ccxt 문서 참고 (`binance`, `upbit`, `bybit`, `okx`, `coinbase`, …) |

거래소별 API 키가 필요 없는 **공개 시세 API**만 사용하므로 키 설정 없이 동작합니다.
특정 거래소에서 어떤 심볼을 쓸 수 있는지는 서버 실행 후
`http://127.0.0.1:8000/api/markets?exchange=binance` 로 확인할 수 있습니다.

## API

| 엔드포인트 | 설명 |
|---|---|
| `GET /api/meta` | 거래소·심볼·타임프레임 목록 + 수집기 상태 |
| `GET /api/candles?exchange=binance&symbol=BTC/USDT&timeframe=1h&limit=500&before=<unix초>` | 캔들 조회(오름차순). `before`로 과거 페이지네이션 |
| `GET /api/markets?exchange=binance` | 해당 거래소의 전체 거래 가능 심볼 |

## 구조

```
├── run.py               # 실행 진입점 (uvicorn)
├── config.json          # 거래소/심볼/주기 설정
├── app/
│   ├── config.py        # 설정 로더
│   ├── db.py            # SQLite 캔들 저장소
│   ├── collector.py     # ccxt 수집기 (백필 + 증분 폴링)
│   ├── main.py          # FastAPI 서버 + REST API
│   └── static/          # 프론트엔드 (lightweight-charts, 오프라인 번들 포함)
```
