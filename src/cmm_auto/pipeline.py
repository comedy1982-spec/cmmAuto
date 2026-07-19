"""단계별 파이프라인 실행: 대본 → 에셋(음성/자막/이미지).

산출물 구조:
  output/{product_id}/
    script.json     대본/제목/설명/해시태그
    subtitle.srt    자막
    timing.json     문장별 오디오 타이밍
    audio/seg_*.mp3 문장별 음성
    product.jpg     상품 이미지
"""
from __future__ import annotations

from pathlib import Path

from .config import Settings
from .db import Database, Product
from .scriptwriter.generator import VideoScript, generate_script
from .assets_gen import tts
from .assets_gen.images import download_image


def product_dir(settings: Settings, product_id: int) -> Path:
    return settings.output_dir / str(product_id)


def run_script_stage(settings: Settings, db: Database, p: Product) -> VideoScript:
    script = generate_script(p, api_key=settings.anthropic_api_key)
    script.save(product_dir(settings, p.product_id) / "script.json")
    db.set_status(p.product_id, "scripted")
    return script


def run_assets_stage(
    settings: Settings,
    db: Database,
    p: Product,
    voice: str = tts.DEFAULT_VOICE,
    skip_image_errors: bool = True,
) -> list[tts.Segment]:
    pdir = product_dir(settings, p.product_id)
    script = VideoScript.load(pdir / "script.json")

    segments = tts.synthesize(script.sentences, pdir / "audio", voice=voice)
    (pdir / "subtitle.srt").write_text(tts.to_srt(segments), encoding="utf-8")
    tts.save_timing(segments, pdir / "timing.json")

    try:
        download_image(p.image_url, pdir / "product.jpg")
    except Exception:
        if not skip_image_errors:
            raise

    db.set_status(p.product_id, "assets_ready")
    return segments
