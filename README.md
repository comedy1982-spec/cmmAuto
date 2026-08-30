# cmmAuto — 암호화폐 캔들 차트 뷰어

여러 암호화폐 거래소의 분봉·시간봉·일봉(OHLCV) 데이터를 **일정 주기로 자동 수집**해서
로컬 SQLite에 쌓고, 브라우저에서 **트레이딩뷰 스타일 차트**(lightweight-charts)로
보여주는 프로그램입니다.

- 거래소: [ccxt](https://github.com/ccxt/ccxt) 기반 — 기본 구성은 **업비트 KRW 마켓(전체)**,
  **바이낸스 USDT 무기한 선물(전체)**, **바이비트 USDT 무기한 선물(전체)**. 다른 거래소도
  config로 추가 가능 (100개 이상 지원)
- 심볼 선택: 드롭다운 대신 **검색**(부분 일치) + **즐겨찾기(★)** — 즐겨찾기는 목록 맨 위에
  고정되고 브라우저에 저장됨. 검색으로 고른 심볼은 서버가 **온디맨드로 수집을 시작**하고,
  보고 있는 동안 계속 갱신하다가 안 보면(기본 15분) 자동으로 수집을 멈춤
- 타임프레임: `1m` `5m` `15m` `1h` `4h` `1d` 수집(설정으로 변경 가능) + **주봉(1w)·월봉(1M)**,
  그리고 봉 그룹의 `+` 버튼으로 **사용자 지정 봉**(예: 3분, 45분, 2시간, 2주) 입력 —
  수집 봉이 아닌 것은 서버가 저장된 캔들에서 자동 리샘플링(집계)해서 표시
- 수집: 서버 시작 시 과거 데이터 백필 → 이후 주기적으로 최신 캔들 증분 수집
- 차트: 캔들 + 거래량, 십자선 OHLC 범례, 왼쪽으로 스크롤하면 과거 데이터 자동 로드,
  2초 주기 실시간 갱신. **시간축·십자선은 한국시간(KST) 기준** 표시 —
  PC 시간대와 무관하게 항상 한국시간
- 지표: 이동평균선(SMA/EMA ×4, 기간 설정), Envelope, 볼린저밴드, 거래량 토글,
  RSI·MACD 서브 패널 — **구획마다 독립 설정** (각 구획의 지표 버튼에서 켜고 끔)
- 멀티 차트: 툴바의 **분할** 버튼으로 화면을 1·2·3·4개 구획으로 나눠 서로 다른
  거래소/심볼/봉을 동시에 표시하고, **구획 경계선을 드래그해 크기 조절**
  (트레이딩뷰 스타일). 분할 상태·크기·구획별 선택/지표는 브라우저에 저장되어 유지됨
- 그리기 도구: 각 구획의 ╱(추세선)·━(수평선)·⇕(가격 범위 측정) 버튼 —
  범위 도구는 가격 변화량·%·봉 수·기간을 표시. 그린 도형은 클릭으로 선택해
  끝점/몸통 드래그로 수정, Del 키로 삭제, ESC로 취소. 심볼별로 저장되며
  봉 종류를 바꿔도 시간·가격 위치가 유지됨
- 가격 알림: 추세선·수평선을 선택하면 나오는 미니 툴바에서 **🔔 알림**을 켜면,
  가격이 그 선을 상향/하향 돌파할 때 화면 토스트 + 알림음 + 브라우저 알림으로
  알려줌 (추세선은 연장선 기준, 같은 선 재알림은 1분 간격 제한)
- 텔레그램 스캐너 알림: 툴바의 **🔔 알림** 버튼 — 업비트(또는 선택한 거래소)의
  **전체 코인**을 주기적으로 스캔해, 지정한 봉(기본 3분봉)에서 가격이 엔벨로프
  밴드(SMA 기간 ± N%, 기본 20기간 ±5%)에 닿으면 텔레그램으로 알림 전송.
  같은 코인·방향은 같은 봉에서 한 번만 알림. 설정 방법:
  1. 텔레그램에서 **@BotFather**에게 `/newbot` → 봇 생성 후 토큰 복사
  2. 만든 봇에게 아무 메시지나 한 번 보내기 (봇이 먼저 말을 걸 수 없음)
  3. **@userinfobot**에게 `/start` → 내 챗 ID 확인
  4. 🔔 알림 패널에 토큰·챗 ID 입력 → **테스트 전송**으로 확인 → **스캐너 켜기** 후 저장
- 레이아웃 프리셋: 툴바의 **레이아웃** 버튼으로 현재 화면 구성(분할·크기·구획별
  심볼/봉/지표/**그리기**)을 이름 붙여 저장하고 언제든 불러오기/삭제 — 서버 DB에
  저장되므로 다른 브라우저에서 열어도 유지됨

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
  "dynamic_ttl_seconds": 900,
  "timeframes": ["1m", "5m", "15m", "1h", "4h", "1d"],
  "exchanges": {
    "upbit":   { "quote": "KRW",  "market_type": "spot", "symbols": ["BTC/KRW"] },
    "binance": { "ccxt_id": "binanceusdm", "quote": "USDT", "market_type": "swap",
                 "symbols": ["BTC/USDT:USDT"] },
    "bybit":   { "quote": "USDT", "market_type": "swap", "symbols": ["BTC/USDT:USDT"] }
  }
}
```

| 항목 | 설명 |
|---|---|
| `poll_interval_seconds` | 심볼 전체를 한 바퀴 수집한 뒤 쉬는 시간(초, 기본 5) |
| `live_refresh_seconds` | 화면에 열려 있는 차트의 최신 캔들 신선도 보장(초, 기본 10) |
| `backfill_candles` | 최초 수집 시 채울 과거 캔들 개수 |
| `dynamic_ttl_seconds` | 검색으로 열어본 심볼을 마지막 조회 후 계속 수집해 주는 시간(초) |
| `timezone_offset_hours` | 주봉·월봉·사용자 지정 봉의 경계 기준 시간대(기본 9 = KST) |
| `timeframes` | 수집할 봉 종류. 거래소가 지원하지 않는 봉은 자동으로 건너뜀 |
| `exchanges.symbols` | **상시** 수집할 기본 심볼 (그 외 심볼은 차트에서 여는 순간 온디맨드 수집) |
| `exchanges.quote` / `market_type` | 심볼 검색 목록 필터 — 예: KRW 현물(`spot`), USDT 무기한(`swap`) |
| `exchanges.ccxt_id` | 실제 ccxt 거래소 id (바이낸스 선물은 `binanceusdm`) |

선물 심볼은 ccxt 표기(`BTC/USDT:USDT` = USDT 무기한)를 그대로 사용합니다.

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
| `GET /api/layouts` · `GET/PUT/DELETE /api/layouts/{이름}` | 차트 레이아웃 프리셋 목록/조회/저장/삭제 |

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
