# Bybit 크립토 모니터

바이비트(Bybit) 공개 API를 활용한 실시간 암호화폐 가격 모니터링 웹앱

## 기능

- 15개 주요 코인 실시간 가격 모니터링 (BTC, ETH, SOL, BNB, XRP 등)
- 캔들스틱 차트 + 거래량 히스토그램
- 다양한 시간봉: 1분 / 5분 / 15분 / 30분 / 1시간 / 4시간 / 12시간 / 1일 / 1주
- 30초 자동 갱신 (토글 가능)
- 코인 검색 필터
- 다크 테마 반응형 UI

## 실행 방법

```bash
# Node.js가 설치된 경우
npm start
# → http://localhost:3000 에서 열기

# 또는 index.html 파일을 브라우저로 직접 열기
```

## 기술 스택

- **차트**: TradingView Lightweight Charts v4
- **데이터**: Bybit V5 Public API (API 키 불필요)
- **UI**: Vanilla HTML/CSS/JS (프레임워크 없음)
