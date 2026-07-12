# cmmAuto — 암호화폐 캔들 차트 뷰어

여러 암호화폐 거래소의 분봉·시간봉·일봉(OHLCV) 데이터를 **일정 주기로 자동 수집**해서
로컬 SQLite에 쌓고, 브라우저에서 **트레이딩뷰 스타일 차트**(lightweight-charts)로
보여주는 프로그램입니다.

- 거래소: [ccxt](https://github.com/ccxt/ccxt) 기반 — 바이낸스, 업비트, 바이비트 등 **100개 이상** 지원
- 타임프레임: `1m` `5m` `15m` `1h` `4h` `1d` (설정으로 변경 가능)
- 수집: 서버 시작 시 과거 데이터 백필 → 이후 주기적으로 최신 캔들 증분 수집
- 차트: 캔들 + 거래량, 십자선 OHLC 범례, 왼쪽으로 스크롤하면 과거 데이터 자동 로드,
  5초 주기 실시간 갱신
- 지표: 이동평균선(SMA/EMA ×4, 기간 설정), Envelope, 볼린저밴드, 거래량 토글,
  RSI·MACD 서브 패널 — **구획마다 독립 설정** (각 구획의 지표 버튼에서 켜고 끔)
- 멀티 차트: 툴바의 **분할** 버튼으로 화면을 1·2·3·4개 구획으로 나눠 서로 다른
  거래소/심볼/봉을 동시에 표시하고, **구획 경계선을 드래그해 크기 조절**
  (트레이딩뷰 스타일). 분할 상태·크기·구획별 선택/지표는 브라우저에 저장되어 유지됨

## 실행 방법

```bash
# 1. 의존성 설치 (Python 3.10+)
pip install -r requirements.txt

# 2. 서버 실행
python run.py            # 기본: http://127.0.0.1:8000
python run.py --port 9000
```

Windows에서는 `run.bat`을 더블클릭하면 의존성 설치와 서버 실행을 한 번에 해 줍니다
(인자도 그대로 전달됩니다: `run.bat --port 9000`).

브라우저에서 <http://127.0.0.1:8000> 이 자동으로 열립니다 (`--no-browser`로 끌 수 있음).
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

## Windows용 exe 만들기

Python 설치 없이 더블클릭으로 실행할 수 있는 `cmmAuto.exe`를 직접 빌드할 수 있습니다.
PyInstaller는 빌드하는 OS용 실행 파일만 만들 수 있으므로, **반드시 Windows PC에서** 아래를
실행해야 합니다.

```bat
build.bat
```

완료되면 `dist\cmmAuto.exe` 가 생성됩니다. 이 파일 하나만 원하는 폴더로 복사해서 실행하면 되고,
그 폴더에 `config.json`과 `data\` 가 없으면 최초 실행 시 자동으로 만들어집니다(기본 설정으로 동작).
실행하면 기본 브라우저가 자동으로 열립니다. `cmmAuto.exe --no-browser`로 자동 열기를 끌 수 있고,
`cmmAuto.exe --port 9000` 처럼 포트도 바꿀 수 있습니다.

`build.bat`이 내부적으로 하는 일:

```bat
pip install -r requirements.txt -r requirements-build.txt
pyinstaller cmmauto.spec
```

## API

| 엔드포인트 | 설명 |
|---|---|
| `GET /api/meta` | 거래소·심볼·타임프레임 목록 + 수집기 상태 |
| `GET /api/candles?exchange=binance&symbol=BTC/USDT&timeframe=1h&limit=500&before=<unix초>` | 캔들 조회(오름차순). `before`로 과거 페이지네이션 |
| `GET /api/markets?exchange=binance` | 해당 거래소의 전체 거래 가능 심볼 |

## 구조

```
├── run.py               # 실행 진입점 (uvicorn)
├── run.bat              # Windows에서 소스로 바로 실행 (의존성 설치 + 서버 실행)
├── config.json          # 거래소/심볼/주기 설정
├── cmmauto.spec         # PyInstaller 빌드 스펙
├── build.bat            # Windows exe 빌드 스크립트
├── requirements-build.txt  # 빌드 전용 의존성 (pyinstaller)
├── app/
│   ├── paths.py          # 일반 실행 / exe 실행 경로 분기
│   ├── config.py         # 설정 로더 (없으면 기본값으로 자동 생성)
│   ├── db.py             # SQLite 캔들 저장소
│   ├── collector.py      # ccxt 수집기 (백필 + 증분 폴링)
│   ├── main.py           # FastAPI 서버 + REST API
│   └── static/           # 프론트엔드 (lightweight-charts, 오프라인 번들 포함)
```
