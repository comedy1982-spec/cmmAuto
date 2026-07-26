# cmmAuto — 쿠팡 상품 자동 쇼츠 영상 생성기

쿠팡 파트너스 API로 상품을 수집하고, 상품별 쇼츠 영상(9:16)을 자동 생성해
YouTube Shorts / Instagram Reels / TikTok에 업로드하는 파이프라인입니다.

**처음 사용하신다면 [QUICKSTART.md](QUICKSTART.md)를 보세요** — 설치부터 첫 영상까지
단계별로 안내합니다 (파트너스 API 키 없이도 실행 가능).
전체 설계는 [PLAN.md](PLAN.md)를 참고하세요.

## 현재 구현 상태

- [x] **M1** 상품 수집: 파트너스 API 클라이언트(검색/베스트/골드박스/딥링크) + SQLite 저장 + CLI
- [x] **M2** 대본 생성(Claude API + 템플릿 폴백) + Edge TTS 음성 + SRT 자막 타이밍
- [x] **M3** FFmpeg 쇼츠 렌더링 (1080x1920, 블러 배경 + 줌인 + 제목/자막 번인 + BGM 믹싱)
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
# 상품 직접 등록 (파트너스 API 키 없이 사용 가능)
cmm-auto add --url "https://www.coupang.com/vp/products/123" \
  --name "상품명" --price 29900 --image "이미지주소" --rocket

# 대본 → 음성/자막 → 영상까지 한 번에
cmm-auto run --id 123
cmm-auto run --all
```

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

# 대본 + 음성 + 자막 생성 (collected → assets_ready)
cmm-auto generate --id 7654321002        # 특정 상품
cmm-auto generate --all                  # collected 상태 전부
cmm-auto generate --all --voice ko-KR-InJoonNeural   # 남성 보이스
```

`ANTHROPIC_API_KEY`가 `.env`에 있으면 Claude가 대본을 쓰고, 없으면 내장
템플릿으로 대본을 생성합니다. 결과물은 `output/{상품ID}/`에 저장됩니다:
`script.json`(대본/제목/설명), `audio/seg_*.mp3`(문장별 음성),
`subtitle.srt`(자막), `timing.json`(타이밍), `product.jpg`(상품 이미지).

```bash
# 쇼츠 영상 렌더링 (assets_ready → rendered) — ffmpeg 필요
cmm-auto render --id 7654321002
cmm-auto render --all
```

렌더링 결과는 `output/{상품ID}/final.mp4`(1080x1920)와 업로드용 메타데이터
`meta.json`(제목/설명/해시태그)입니다. `assets/bgm/`에 mp3를 넣어두면
랜덤으로 골라 배경음악으로 깔아줍니다(음량 자동 감쇠). 한글 자막/제목
렌더링에는 나눔고딕 등 한글 폰트가 설치되어 있어야 합니다.

수집된 상품은 `data/cmm_auto.db`(SQLite)에 저장되며, 파이프라인 상태는
`collected → scripted → assets_ready → rendered → uploaded` 순으로 진행됩니다.
이미 수집된 상품은 중복 저장되지 않고 진행 상태가 보존됩니다.

## 테스트

```bash
python -m pytest
```
