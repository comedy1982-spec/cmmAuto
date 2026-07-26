# 처음 실행하기 (설치 → 첫 영상까지)

파트너스 API 승인을 기다리는 동안에도 **상품을 직접 입력해서** 영상을 만들 수 있습니다.
전체 과정은 15~20분 정도 걸립니다.

---

## 1단계. 필요한 프로그램 설치

### Windows

1. **Python 설치** — [python.org/downloads](https://www.python.org/downloads/)에서 최신 버전 다운로드
   - 설치 화면 맨 아래 **"Add Python to PATH"에 반드시 체크**하고 설치하세요. 이걸 빠뜨리면 나중에 명령어가 인식되지 않습니다.
2. **FFmpeg 설치** — 영상을 만드는 프로그램입니다. 아래를 PowerShell에 붙여넣으세요:
   ```powershell
   winget install Gyan.FFmpeg
   ```
   설치 후 **PowerShell 창을 닫았다가 다시 여세요.**
3. **한글 폰트** — 윈도우에는 맑은 고딕이 기본 설치되어 있어 추가 작업이 필요 없습니다.

### macOS

```bash
brew install python ffmpeg
brew install --cask font-nanum-gothic
```

### 설치 확인

새 터미널(PowerShell)에서:

```bash
python --version
ffmpeg -version
```

둘 다 버전 번호가 나오면 성공입니다. `'python'은(는) 내부 또는 외부 명령...` 같은 오류가 나오면 PATH 체크를 빠뜨린 것이니 Python을 다시 설치하세요.

---

## 2단계. 프로그램 내려받기 및 설치

```bash
git clone https://github.com/comedy1982-spec/cmmAuto.git
cd cmmAuto
git checkout claude/coupang-auto-short-video-f3kzvb

python -m venv .venv
```

가상환경을 켭니다 (터미널을 새로 열 때마다 필요):

- **Windows**: `.venv\Scripts\activate`
- **macOS**: `source .venv/bin/activate`

그다음 설치:

```bash
pip install -e .
```

설치가 끝나면 확인:

```bash
cmm-auto --help
```

명령어 목록이 나오면 준비 완료입니다.

---

## 3단계. 첫 영상 만들기 — 웹 화면 (권장)

명령어 대신 브라우저에서 클릭으로 할 수 있습니다.

```bash
cmm-auto web
```

브라우저가 자동으로 열립니다 (안 열리면 주소창에 `http://localhost:8000` 입력).

1. 왼쪽 **상품 등록** 칸을 채웁니다
   - 쿠팡 상품 페이지 주소
   - 상품명, 가격
   - 상품 이미지 주소 — 쿠팡 상품 사진에서 **우클릭 → "이미지 주소 복사"**
   - 로켓배송이면 체크
2. **상품 등록** 버튼을 누르면 오른쪽 목록에 나타납니다
3. 그 상품의 **영상 만들기** 버튼을 누릅니다
4. 진행 막대가 3단계(대본 → 음성·자막 → 영상)로 채워집니다
5. 완성되면 **미리보기** 버튼으로 영상을 재생하고, 제목·설명문·해시태그를 **복사** 버튼으로 가져다 유튜브에 붙여넣으면 됩니다

화면 오른쪽 위 **전체 생성** 버튼을 누르면 아직 영상이 없는 상품을 한꺼번에 처리합니다.
목소리도 그 옆에서 바꿀 수 있습니다.

> 웹 화면은 본인 컴퓨터에서만 열립니다. 종료하려면 터미널에서 `Ctrl+C`를 누르세요.

---

## 3단계(대안). 명령어로 만들기

터미널이 편하시면 명령어로도 똑같이 할 수 있습니다.

### 3-1. 상품 정보 준비

쿠팡에서 홍보하고 싶은 상품 페이지를 엽니다. 두 가지를 복사해 두세요:

- **상품 페이지 주소** — 브라우저 주소창의 URL
- **상품 이미지 주소** — 상품 대표 사진에서 **마우스 우클릭 → "이미지 주소 복사"**

### 3-2. 상품 등록

```bash
cmm-auto add ^
  --url "여기에_상품페이지_주소" ^
  --name "상품명" ^
  --price 29900 ^
  --image "여기에_이미지_주소" ^
  --category "주방가전" ^
  --rocket
```

> Windows PowerShell에서는 줄바꿈 기호가 `^`, macOS에서는 `\` 입니다. 헷갈리면 그냥 한 줄로 길게 쓰셔도 됩니다.
> `--rocket`은 로켓배송 상품일 때만 붙이세요.

실행하면 상품 번호와 함께 "등록 완료"가 뜹니다.

### 3-3. 영상 생성

```bash
cmm-auto run --id 방금_나온_상품번호
```

세 단계가 순서대로 진행됩니다:

```
1/3 대본 5문장 | 상품명 29,900원, 이 가격 실화? 🔥
2/3 음성·자막 5문장, 15.4초
3/3 ✓ 영상 완성 → output/1234567890/final.mp4
```

`output/상품번호/final.mp4`를 열어보시면 완성된 세로 영상이 있습니다.

---

## 4단계. 업로드

같은 폴더의 `meta.json`에 업로드에 필요한 것들이 들어 있습니다:

- `title` — 영상 제목
- `description` — 설명문 (구매 링크 + 쿠팡 파트너스 필수 문구 포함)
- `hashtags` — 해시태그

유튜브 스튜디오에서 `final.mp4`를 올리고, 제목과 설명을 복사해 붙여넣으면 됩니다.
(M5 단계에서 이 업로드도 자동화할 예정입니다.)

> ⚠️ 설명문의 **"이 포스팅은 쿠팡 파트너스 활동의 일환으로..."** 문구는 파트너스 규정상 반드시 포함되어야 합니다. 지우지 마세요.

---

## 선택 사항

### 배경음악 넣기

`assets/bgm/` 폴더를 만들고 저작권 없는 mp3를 몇 개 넣어두면, 영상마다 랜덤으로 골라서 깔아줍니다 (내레이션보다 작게 자동 조절).

유튜브 스튜디오 → 오디오 보관함에서 무료 음원을 받을 수 있습니다.

### 목소리 바꾸기

```bash
cmm-auto run --id 상품번호 --voice ko-KR-InJoonNeural
```

| 보이스 이름 | 설명 |
|---|---|
| `ko-KR-SunHiNeural` | 여성 (기본값) |
| `ko-KR-InJoonNeural` | 남성 |
| `ko-KR-HyunsuMultilingualNeural` | 남성, 자연스러운 톤 |

### 더 좋은 대본 쓰기

`.env` 파일을 만들고 아래를 넣으면 Claude가 상품에 맞는 대본을 직접 씁니다 (없으면 기본 템플릿 사용):

```
ANTHROPIC_API_KEY=여기에_키
```

키는 [console.anthropic.com](https://console.anthropic.com)에서 발급받습니다. 영상 한 편당 비용은 1원 미만입니다.

### 파트너스 승인 후 (자동 수집)

승인이 나면 `.env`에 키를 넣으세요:

```
COUPANG_ACCESS_KEY=발급받은키
COUPANG_SECRET_KEY=발급받은시크릿
```

그러면 상품을 하나씩 입력할 필요 없이 자동으로 모아옵니다:

```bash
cmm-auto collect --keyword "무선 이어폰" --limit 10   # 키워드 검색
cmm-auto collect --goldbox                            # 오늘의 특가
cmm-auto run --all                                    # 모은 상품 전부 영상화
```

---

## 문제가 생겼을 때

| 증상 | 해결 |
|---|---|
| `'cmm-auto'은(는) 내부 또는 외부 명령...` | 가상환경이 꺼져 있습니다. `.venv\Scripts\activate` 실행 |
| 웹 화면이 안 열림 | 주소창에 `http://localhost:8000` 직접 입력. 포트가 겹치면 `cmm-auto web --port 8100` |
| 웹 화면에서 미리보기 영상이 안 나옴 | 브라우저를 새로고침하거나 `output/상품번호/final.mp4`를 직접 열어보세요 |
| `ffmpeg가 설치되어 있지 않습니다` | 1단계의 FFmpeg 설치 후 터미널을 새로 여세요 |
| `음성 합성 실패` | 인터넷 연결 확인. 회사 네트워크나 VPN이 막는 경우가 많으니 다른 네트워크에서 시도 |
| 영상의 한글이 네모(□)로 나옴 | 한글 폰트가 없습니다. macOS는 나눔고딕 설치, Windows는 보통 문제없음 |
| `상품 이미지가 없습니다` | 이미지 주소가 잘못됐습니다. 우클릭 → "이미지 주소 복사"로 다시 받으세요 |
