from pathlib import Path
from unittest.mock import patch

from cmm_auto.assets_gen import tts
from cmm_auto.assets_gen.tts import Segment, load_timing, save_timing, to_srt


def test_srt_formatting():
    segments = [
        Segment(index=0, text="첫 문장", audio_path="a.mp3", start=0.0, duration=2.5),
        Segment(index=1, text="둘째 문장", audio_path="b.mp3", start=2.85, duration=3.2),
    ]
    srt = to_srt(segments)
    assert "1\n00:00:00,000 --> 00:00:02,500\n첫 문장" in srt
    assert "2\n00:00:02,850 --> 00:00:06,050\n둘째 문장" in srt


def test_timing_roundtrip(tmp_path):
    segments = [Segment(index=0, text="문장", audio_path="a.mp3", start=0.0, duration=1.0)]
    path = tmp_path / "timing.json"
    save_timing(segments, path)
    assert load_timing(path) == segments


def test_synthesize_accumulates_offsets(tmp_path):
    async def fake_synth(text, voice, rate, out_path):
        Path(out_path).write_bytes(b"fake-mp3")
        return 2.0  # 문장마다 2초라고 가정

    with patch.object(tts, "_synth_sentence", side_effect=fake_synth):
        segments = tts.synthesize(["하나", "둘", "셋"], tmp_path)

    assert [s.start for s in segments] == [
        0.0,
        2.0 + tts.SENTENCE_GAP,
        (2.0 + tts.SENTENCE_GAP) * 2,
    ]
    assert all(Path(s.audio_path).exists() for s in segments)
