"""FFmpeg 기반 쇼츠 렌더러 (1080x1920).

구성:
  배경: 상품 이미지를 블러 + 어둡게 확대
  전경: 상품 이미지 중앙 배치 + 느린 줌인(Ken Burns)
  상단: 영상 제목 텍스트
  하단: SRT 자막 번인
  오디오: 문장별 TTS 세그먼트를 간격(SENTENCE_GAP)으로 이어붙임 + BGM 믹싱
"""
from __future__ import annotations

import json
import random
import shutil
import subprocess
import sys
from dataclasses import asdict
from pathlib import Path

from ..assets_gen.tts import SENTENCE_GAP, Segment
from ..scriptwriter.generator import VideoScript

WIDTH, HEIGHT = 1080, 1920
FPS = 30
OUTRO_PAD = 1.2  # 마지막 문장 후 여유(초)

# 운영체제별로 흔한 한글 폰트 (앞에서부터 설치된 것을 사용)
KOREAN_FONTS = (
    "NanumGothic",          # Linux/macOS (fonts-nanum)
    "Malgun Gothic",        # Windows 기본
    "AppleSDGothicNeo",     # macOS 기본
    "NotoSansCJKkr",
    "Noto Sans KR",
    "WenQuanYi Zen Hei",    # 최후 폴백 (CJK 지원)
)


class RenderError(RuntimeError):
    pass


def ensure_ffmpeg() -> None:
    if not shutil.which("ffmpeg"):
        raise RenderError(
            "ffmpeg가 설치되어 있지 않습니다. https://ffmpeg.org 에서 설치 후 다시 실행하세요."
        )


def detect_korean_font() -> str:
    """설치된 한글 폰트를 찾는다. fc-list가 없는 환경(Windows)에서는 OS 기본값."""
    if shutil.which("fc-list"):
        try:
            installed = subprocess.run(
                ["fc-list", ":lang=ko", "family"], capture_output=True, text=True, timeout=10
            ).stdout
            for font in KOREAN_FONTS:
                if font.lower().replace(" ", "") in installed.lower().replace(" ", ""):
                    return font
        except (subprocess.SubprocessError, OSError):
            pass
    if sys.platform == "win32":
        return "Malgun Gothic"
    if sys.platform == "darwin":
        return "AppleSDGothicNeo"
    return KOREAN_FONTS[0]


def _run(cmd: list[str]) -> None:
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RenderError(f"ffmpeg 실패 (exit {proc.returncode}):\n{proc.stderr[-2000:]}")


def build_narration(segments: list[Segment], out_path: Path, gap: float = SENTENCE_GAP) -> Path:
    """문장별 mp3를 무음 간격과 함께 하나의 오디오로 합친다."""
    if not segments:
        raise RenderError("오디오 세그먼트가 없습니다.")
    out_path.parent.mkdir(parents=True, exist_ok=True)

    cmd: list[str] = ["ffmpeg", "-y"]
    for seg in segments:
        cmd += ["-i", seg.audio_path]
    # 세그먼트 사이 + 마지막 뒤에 넣을 무음 소스
    cmd += ["-f", "lavfi", "-t", f"{gap:.3f}", "-i", "anullsrc=r=44100:cl=stereo"]
    sil_idx = len(segments)

    parts: list[str] = []
    labels: list[str] = []
    for i in range(len(segments)):
        parts.append(f"[{i}:a]aresample=44100,aformat=channel_layouts=stereo[a{i}]")
        labels.append(f"[a{i}]")
        if i < len(segments) - 1:
            labels.append(f"[{sil_idx}:a]")
    n = len(labels)
    filter_complex = ";".join(parts) + f";{''.join(labels)}concat=n={n}:v=0:a=1[out]"

    cmd += ["-filter_complex", filter_complex, "-map", "[out]", str(out_path)]
    _run(cmd)
    return out_path


def _wrap_title(title: str, max_chars: int = 14, max_lines: int = 2) -> str:
    """drawtext는 자동 줄바꿈이 없어 제목을 수동으로 감싼다."""
    words = title.split(" ")
    lines: list[str] = [""]
    for w in words:
        if len(lines[-1]) + len(w) + 1 <= max_chars or not lines[-1]:
            lines[-1] = f"{lines[-1]} {w}".strip()
        else:
            if len(lines) >= max_lines:
                lines[-1] = lines[-1][: max_chars - 1] + "…"
                break
            lines.append(w)
    return "\n".join(lines)


def _ff_path(p: Path) -> str:
    """ffmpeg 필터 인자 안의 경로 이스케이프 (':' 처리)."""
    return str(p).replace("\\", "/").replace(":", "\\:")


def render_video(
    image_path: Path,
    narration_path: Path,
    srt_path: Path,
    title: str,
    total_duration: float,
    out_path: Path,
    bgm_path: Path | None = None,
    font: str | None = None,
) -> Path:
    ensure_ffmpeg()
    font = font or detect_korean_font()

    title_file = out_path.parent / "title.txt"
    title_file.write_text(_wrap_title(title), encoding="utf-8")

    cmd: list[str] = ["ffmpeg", "-y", "-loop", "1", "-i", str(image_path), "-i", str(narration_path)]
    if bgm_path:
        cmd += ["-stream_loop", "-1", "-i", str(bgm_path)]

    subtitle_style = (
        f"FontName={font},FontSize=17,Bold=1,PrimaryColour=&H00FFFFFF,"
        "OutlineColour=&H00000000,Outline=2,Shadow=0,Alignment=2,MarginV=55"
    )
    vf = (
        # 배경: 화면을 꽉 채우는 블러 이미지
        f"[0:v]scale={WIDTH}:{HEIGHT}:force_original_aspect_ratio=increase,"
        f"crop={WIDTH}:{HEIGHT},boxblur=28:4,eq=brightness=-0.18[bg];"
        # 전경: 상품 이미지
        f"[0:v]scale=900:-2[fg];"
        f"[bg][fg]overlay=(W-w)/2:(H-h)/2-60[base];"
        # 느린 줌인
        f"[base]zoompan=z='min(1+0.0004*on,1.10)':"
        f"x='(iw-iw/zoom)/2':y='(ih-ih/zoom)/2':d=1:s={WIDTH}x{HEIGHT}:fps={FPS}[zoomed];"
        # 제목
        f"[zoomed]drawtext=textfile='{_ff_path(title_file)}':font='{font}':"
        f"fontsize=58:fontcolor=white:borderw=4:bordercolor=black:"
        f"x=(w-text_w)/2:y=170:line_spacing=14[titled];"
        # 자막 번인
        f"[titled]subtitles='{_ff_path(srt_path)}':force_style='{subtitle_style}'[vout]"
    )

    if bgm_path:
        af = "[1:a][2:a]amix=inputs=2:duration=first:weights='1 0.22'[aout]"
        vf = vf + ";" + af
        audio_map = "[aout]"
    else:
        audio_map = "1:a"

    cmd += [
        "-filter_complex", vf,
        "-map", "[vout]", "-map", audio_map,
        "-t", f"{total_duration:.2f}",
        "-c:v", "libx264", "-preset", "medium", "-crf", "21",
        "-pix_fmt", "yuv420p", "-r", str(FPS),
        "-c:a", "aac", "-b:a", "160k",
        str(out_path),
    ]
    _run(cmd)
    return out_path


def pick_bgm(bgm_dir: Path) -> Path | None:
    if not bgm_dir.is_dir():
        return None
    tracks = sorted(
        p for p in bgm_dir.iterdir() if p.suffix.lower() in (".mp3", ".m4a", ".wav", ".ogg")
    )
    return random.choice(tracks) if tracks else None


def render_product(pdir: Path, bgm_dir: Path | None = None) -> Path:
    """output/{id}/ 디렉터리의 에셋으로 final.mp4 + meta.json 생성."""
    script = VideoScript.load(pdir / "script.json")
    segments = [
        Segment(**d) for d in json.loads((pdir / "timing.json").read_text(encoding="utf-8"))
    ]
    image = pdir / "product.jpg"
    if not image.exists():
        raise RenderError(f"상품 이미지가 없습니다: {image}")

    narration = build_narration(segments, pdir / "narration.wav")
    total = segments[-1].end + OUTRO_PAD

    bgm = pick_bgm(bgm_dir) if bgm_dir else None
    out = render_video(
        image_path=image,
        narration_path=narration,
        srt_path=pdir / "subtitle.srt",
        title=script.title,
        total_duration=total,
        out_path=pdir / "final.mp4",
        bgm_path=bgm,
    )

    meta = {
        "product_id": script.product_id,
        "title": script.title,
        "description": script.description,
        "hashtags": script.hashtags,
        "duration_sec": round(total, 2),
        "video_path": str(out),
        "bgm": str(bgm) if bgm else None,
    }
    (pdir / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    return out
