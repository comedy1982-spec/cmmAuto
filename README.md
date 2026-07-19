# cmmAuto — 쿠팡 상품 자동 쇼츠 영상 생성기

쿠팡 파트너스 API로 상품을 수집하고, 상품별 쇼츠 영상(9:16)을 자동 생성해
YouTube Shorts / Instagram Reels / TikTok에 업로드하는 파이프라인입니다.
전체 설계는 [PLAN.md](PLAN.md)를 참고하세요.

## 현재 구현 상태

- [x] **M1** 상품 수집: 파트너스 API 클라이언트(검색/베스트/골드박스/딥링크) + SQLite 저장 + CLI
- [ ] M2 대본 생성 + Edge TTS
- [ ] M3 영상 렌더링
- [ ] M4 파이프라인 통합
- [ ] M5 YouTube 업로드
- [ ] M6 Instagram / TikTok 업로드 + 스케줄러

## 설치

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
cp .env.example .env   # 쿠팡 파트너스 키 입력
```

`.env`에 [쿠팡 파트너스](https://partners.coupang.com)에서 발급받은
`COUPANG_ACCESS_KEY`, `COUPANG_SECRET_KEY`를 넣어야 합니다.

## 사용법

```bash
# 키워드 검색으로 상품 수집 (딥링크 자동 발급)
cmm-auto collect --keyword "무선 이어폰" --limit 10

# 베스트 카테고리 수집 (예: 1016 = 가전디지털)
cmm-auto collect --category 1016 --limit 20 --rocket-only

# 골드박스(오늘의 특가) 수집 + 가격 필터
cmm-auto collect --goldbox --min-price 10000 --max-price 100000

# 저장된 상품 확인
cmm-auto list
cmm-auto list --status collected
```

수집된 상품은 `data/cmm_auto.db`(SQLite)에 저장되며, 파이프라인 상태는
`collected → scripted → assets_ready → rendered → uploaded` 순으로 진행됩니다.
이미 수집된 상품은 중복 저장되지 않고 진행 상태가 보존됩니다.

## 테스트

```bash
python -m pytest
```
