import json
import shutil
import subprocess
from pathlib import Path

import pytest

from cmm_auto.assets_gen.tts import Segment, save_timing, to_srt
from cmm_auto.renderer.ffmpeg_renderer import (
    _wrap_title,
    build_narration,
    pick_bgm,
    render_product,
)
from cmm_auto.scriptwriter.generator import VideoScript

ffmpeg_available = shutil.which("ffmpeg") is not None
needs_ffmpeg = pytest.mark.skipif(not ffmpeg_available, reason="ffmpeg 미설치")


def test_wrap_title_short():
    assert _wrap_title("짧은 제목") == "짧은 제목"


def test_wrap_title_wraps_and_truncates():
    wrapped = _wrap_title("아주 아주 아주 아주 아주 아주 아주 긴 제목입니다 정말로", max_chars=10, max_lines=2)
    lines = wrapped.split("\n")
    assert len(lines) == 2
    assert lines[1].endswith("…")


def test_pick_bgm_empty_dir(tmp_path):
    assert pick_bgm(tmp_path) is None
    assert pick_bgm(tmp_path / "없는폴더") is None


def _make_silent_mp3(path: Path, seconds: float):
    subprocess.run(
        ["ffmpeg", "-y", "-f", "lavfi", "-t", str(seconds), "-i",
         "sine=frequency=440:sample_rate=24000", str(path)],
        check=True, capture_output=True,
    )


def _probe_duration(path: Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "quiet", "-show_entries", "format=duration",
         "-of", "csv=p=0", str(path)],
        check=True, capture_output=True, text=True,
    )
    return float(out.stdout.strip())


@needs_ffmpeg
def test_build_narration_duration(tmp_path):
    segs = []
    cursor = 0.0
    for i in range(3):
        p = tmp_path / f"seg_{i}.mp3"
        _make_silent_mp3(p, 1.0)
        segs.append(Segment(index=i, text=f"문장 {i}", audio_path=str(p), start=cursor, duration=1.0))
        cursor += 1.0 + 0.35

    out = build_narration(segs, tmp_path / "narration.wav", gap=0.35)
    # 1.0*3 + 0.35*2 = 3.7초 (±0.3 오차 허용)
    assert abs(_probe_duration(out) - 3.7) < 0.3


@needs_ffmpeg
def test_render_product_end_to_end(tmp_path):
    pdir = tmp_path / "123"
    pdir.mkdir()
    # 상품 이미지 (단색 640x640)
    subprocess.run(
        ["ffmpeg", "-y", "-f", "lavfi", "-i", "color=c=orange:s=640x640", "-frames:v", "1",
         str(pdir / "product.jpg")],
        check=True, capture_output=True,
    )
    # 음성 세그먼트 2개
    segs = []
    cursor = 0.0
    for i, text in enumerate(["첫 번째 문장입니다", "두 번째 문장입니다"]):
        p = pdir / f"seg_{i}.mp3"
        _make_silent_mp3(p, 1.2)
        segs.append(Segment(index=i, text=text, audio_path=str(p), start=cursor, duration=1.2))
        cursor += 1.2 + 0.35
    save_timing(segs, pdir / "timing.json")
    (pdir / "subtitle.srt").write_text(to_srt(segs), encoding="utf-8")
    VideoScript(
        product_id=123, title="테스트 상품 9,900원 실화?", sentences=[s.text for s in segs],
        hashtags=["#테스트"], description="설명",
    ).save(pdir / "script.json")

    out = render_product(pdir)
    assert out.exists() and out.stat().st_size > 10_000
    meta = json.loads((pdir / "meta.json").read_text(encoding="utf-8"))
    assert meta["title"] == "테스트 상품 9,900원 실화?"
    assert abs(_probe_duration(out) - meta["duration_sec"]) < 0.5
