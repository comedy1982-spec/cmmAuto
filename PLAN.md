# 쿠팡 상품 자동 쇼츠 영상 생성 프로그램 — 개발 플랜

## 1. 목표

쿠팡 파트너스 API로 상품 정보를 수집해 상품 리스트를 만들고, 각 상품에 대해
쇼츠 영상(9:16, 15~60초)을 자동 구성·렌더링한 뒤, YouTube Shorts / Instagram
Reels / TikTok에 자동 업로드하는 파이프라인을 구축한다.

## 2. 전체 아키텍처

```
[1 수집]            [2 스크립트]         [3 에셋]           [4 렌더링]          [5 업로드]
쿠팡 파트너스 API → LLM 대본 생성    → Edge TTS 음성     → FFmpeg/moviepy → YouTube Shorts
상품 검색/베스트     (후킹 멘트,        상품 이미지 다운    9:16 합성,        Instagram Reels
카테고리 수집        특징 요약,         자막(SRT) 생성      자막/BGM/전환     TikTok
딥링크 발급          CTA)               BGM 선택            효과
        ↓                                                        ↓
   products DB(SQLite) ←──────────── 상태 추적 (수집→대본→렌더→업로드) ────────────→ 결과 기록
```

## 3. 기술 스택

| 영역 | 선택 | 비고 |
|---|---|---|
| 언어 | Python 3.11+ | 전 파이프라인 단일 언어 |
| 상품 수집 | 쿠팡 파트너스 Open API | HMAC 서명 인증, 딥링크 발급 포함 |
| 대본 생성 | Claude API (claude-haiku-4-5) | 상품당 짧은 대본이라 저비용 모델로 충분 |
| 음성(TTS) | edge-tts (무료) | 한국어 보이스 `ko-KR-SunHiNeural` 등 |
| 영상 합성 | FFmpeg + moviepy | 1080x1920, 이미지 줌/팬(Ken Burns), 자막 번인 |
| 자막 | ASS/SRT 생성 후 FFmpeg 번인 | TTS 타이밍 기반 |
| 저장소 | SQLite | 상품/작업 상태/업로드 이력 |
| 업로드 | YouTube Data API v3, Instagram Graph API, TikTok Content Posting API | 각각 OAuth 설정 필요 |
| 실행 | CLI (typer) + 스케줄러(cron) | `collect` / `generate` / `upload` / `run-all` 명령 |

## 4. 파이프라인 상세

### 4.1 상품 수집 (collector)
- 파트너스 API로 키워드 검색·베스트 카테고리·골드박스 상품 조회
- 필터링: 가격대, 평점, 로켓배송 여부, 중복(이미 영상화한 상품) 제외
- 상품별 딥링크(제휴 링크) 발급 → 영상 설명란에 삽입
- SQLite `products` 테이블에 저장, 상태 = `collected`

### 4.2 대본 생성 (scriptwriter)
- 상품명/가격/할인율/특징을 입력으로 LLM이 30~45초 분량 대본 생성
- 구조: 후킹(3초) → 핵심 특징 2~3개 → 가격/할인 강조 → CTA("링크는 댓글에")
- 함께 생성: 영상 제목, 설명문(딥링크 포함), 해시태그
- 상태 = `scripted`

### 4.3 에셋 준비 (assets)
- 상품 이미지 다운로드(파트너스 API 제공 이미지 URL 사용 — 저작권 안전)
- edge-tts로 문장 단위 음성 생성 → 문장별 길이 측정해 자막 타이밍 산출
- BGM: 저작권 무료 트랙 풀에서 랜덤 선택(assets/bgm/)
- 상태 = `assets_ready`

### 4.4 영상 렌더링 (renderer)
- 1080x1920 캔버스, 장면 구성:
  1. 인트로: 상품 이미지 + 후킹 텍스트 (줌인 효과)
  2. 본문: 이미지 전환(크로스페이드/슬라이드) + 특징 자막
  3. 아웃트로: 가격/할인 강조 카드 + CTA
- 자막 번인(큰 글씨, 외곽선), 음성 + BGM(덕킹 -12dB) 믹싱
- 출력: `output/{product_id}/final.mp4` + `meta.json`(제목/설명/태그)
- 상태 = `rendered`

### 4.5 업로드 (uploader)
- YouTube: Data API v3 `videos.insert` (OAuth 리프레시 토큰)
- Instagram Reels: Graph API (비즈니스 계정 + 공개 URL 필요 → 임시 호스팅 또는 수동 대체 가능)
- TikTok: Content Posting API (개발자 앱 심사 필요)
- 플랫폼별 업로드 결과·영상 ID 기록, 실패 시 재시도 큐
- 상태 = `uploaded`

## 5. 프로젝트 구조

```
cmmAuto/
├── src/cmm_auto/
│   ├── config.py          # 설정/환경변수 로드
│   ├── db.py              # SQLite 모델·상태 머신
│   ├── collector/         # 쿠팡 파트너스 API 클라이언트
│   ├── scriptwriter/      # LLM 대본 생성
│   ├── assets/            # 이미지 다운로드, TTS, BGM
│   ├── renderer/          # FFmpeg/moviepy 합성
│   ├── uploader/          # youtube.py / instagram.py / tiktok.py
│   └── cli.py             # typer CLI
├── assets/bgm/            # 저작권 무료 BGM
├── assets/fonts/          # 자막 폰트(예: Pretendard)
├── output/                # 생성된 영상
├── .env.example           # 필요한 키 목록
└── tests/
```

## 6. 개발 단계 (마일스톤)

| 단계 | 내용 | 산출물 |
|---|---|---|
| M1 | 프로젝트 뼈대 + 쿠팡 파트너스 API 클라이언트 + SQLite | `collect` 명령으로 상품 리스트 저장 |
| M2 | 대본 생성 + Edge TTS + 자막 타이밍 | 상품 1개 → 대본/음성/자막 파일 |
| M3 | 렌더러: 이미지+음성+자막+BGM → mp4 | 완성 쇼츠 영상 1편 자동 생성 |
| M4 | 파이프라인 통합 (`run-all`) + 중복 방지·재시도 | 상품 N개 일괄 영상 생성 |
| M5 | YouTube 업로드 자동화 | 업로드까지 원클릭 |
| M6 | Instagram / TikTok 업로드 + 스케줄러 | 멀티 플랫폼 정기 자동 업로드 |

## 7. 사전 준비물 (사용자 액션 필요)

1. **쿠팡 파트너스** 가입 → Access Key / Secret Key 발급
2. **Anthropic API 키** (대본 생성용)
3. **YouTube**: Google Cloud 프로젝트 생성 → YouTube Data API 활성화 → OAuth 클라이언트
4. **Instagram**: 비즈니스/크리에이터 계정 + Facebook 개발자 앱 (Reels 게시 권한)
5. **TikTok**: TikTok for Developers 앱 등록 + Content Posting API 심사
6. 저작권 무료 BGM 파일 몇 개 (YouTube 오디오 라이브러리 등)

## 8. 리스크 및 대응

- **Instagram/TikTok API 심사 지연** → M5(YouTube)까지 먼저 완성하고 나머지는 심사 완료 후 활성화. 심사 전에는 렌더링된 파일 수동 업로드로 운영 가능.
- **파트너스 API 호출 제한** → 수집 주기 조절, 캐싱.
- **쇼츠 품질 단조로움** → 템플릿 여러 벌(인트로 스타일, 자막 스타일, BGM) 랜덤 조합으로 다양화.
- **파트너스 규정** → 영상 설명에 "쿠팡 파트너스 활동으로 수수료를 제공받을 수 있습니다" 문구 자동 삽입 (규정 필수).
