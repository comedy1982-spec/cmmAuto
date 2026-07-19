"""Edge TTS 음성 합성 + 문장 단위 타이밍 → SRT 자막 생성.

문장별로 mp3 세그먼트를 만들고, WordBoundary 이벤트로 각 문장의 실제
발화 길이를 측정해 자막 타이밍을 계산한다. (렌더링 단계에서 세그먼트를
이어붙이므로 타이밍은 누적 오프셋 기준)
"""
from __future__ import annotations

import asyncio
import json
import os
from dataclasses import asdict, dataclass
from pathlib import Path

import edge_tts

DEFAULT_VOICE = "ko-KR-SunHiNeural"
# 문장 사이 간격(초) — 렌더링 시 세그먼트 사이에 넣을 무음과 일치해야 한다
SENTENCE_GAP = 0.35


@dataclass
class Segment:
    index: int
    text: str
    audio_path: str
    start: float      # 전체 오디오 기준 시작 시각(초)
    duration: float   # 발화 길이(초)

    @property
    def end(self) -> float:
        return self.start + self.duration


async def _synth_sentence(text: str, voice: str, rate: str, out_path: Path) -> float:
    """문장 하나를 합성하고 발화 길이(초)를 반환한다."""
    # 프록시 환경(HTTPS_PROXY)에서도 동작하도록 자동 전달
    proxy = os.getenv("HTTPS_PROXY") or os.getenv("https_proxy") or None
    communicate = edge_tts.Communicate(text, voice, rate=rate, proxy=proxy)
    last_end_100ns = 0
    with open(out_path, "wb") as f:
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                f.write(chunk["data"])
            elif chunk["type"] == "WordBoundary":
                last_end_100ns = max(last_end_100ns, chunk["offset"] + chunk["duration"])
    return last_end_100ns / 10_000_000


async def synthesize_async(
    sentences: list[str],
    out_dir: Path,
    voice: str = DEFAULT_VOICE,
    rate: str = "+8%",
) -> list[Segment]:
    out_dir.mkdir(parents=True, exist_ok=True)
    segments: list[Segment] = []
    cursor = 0.0
    for i, text in enumerate(sentences):
        path = out_dir / f"seg_{i:02d}.mp3"
        duration = await _synth_sentence(text, voice, rate, path)
        segments.append(
            Segment(index=i, text=text, audio_path=str(path), start=cursor, duration=duration)
        )
        cursor += duration + SENTENCE_GAP
    return segments


def synthesize(sentences: list[str], out_dir: Path, voice: str = DEFAULT_VOICE, rate: str = "+8%") -> list[Segment]:
    return asyncio.run(synthesize_async(sentences, out_dir, voice, rate))


def _fmt_ts(seconds: float) -> str:
    ms = int(round(seconds * 1000))
    h, rem = divmod(ms, 3_600_000)
    m, rem = divmod(rem, 60_000)
    s, ms = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def to_srt(segments: list[Segment]) -> str:
    blocks = []
    for seg in segments:
        blocks.append(f"{seg.index + 1}\n{_fmt_ts(seg.start)} --> {_fmt_ts(seg.end)}\n{seg.text}\n")
    return "\n".join(blocks)


def save_timing(segments: list[Segment], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps([asdict(s) for s in segments], ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def load_timing(path: Path) -> list[Segment]:
    return [Segment(**d) for d in json.loads(path.read_text(encoding="utf-8"))]
