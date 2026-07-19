"""쇼츠 대본 생성: Claude API 사용, API 키가 없으면 템플릿 기반 폴백.

대본 구조: 후킹(1문장) → 특징 2~3문장 → 가격/할인 강조 → CTA
"""
from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path

from ..db import Product

# 쿠팡 파트너스 규정상 필수 문구
DISCLOSURE = "이 포스팅은 쿠팡 파트너스 활동의 일환으로, 이에 따른 일정액의 수수료를 제공받습니다."

_SCRIPT_SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string", "description": "쇼츠 영상 제목 (40자 이내, 클릭 유도)"},
        "sentences": {
            "type": "array",
            "items": {"type": "string"},
            "description": "내레이션 문장 5~7개. 첫 문장은 후킹, 마지막은 CTA.",
        },
        "hashtags": {"type": "array", "items": {"type": "string"}},
        "description_body": {"type": "string", "description": "영상 설명문 본문 (링크 제외)"},
    },
    "required": ["title", "sentences", "hashtags", "description_body"],
    "additionalProperties": False,
}


@dataclass
class VideoScript:
    product_id: int
    title: str
    sentences: list[str]
    hashtags: list[str]
    description: str
    source: str = "template"  # template | llm

    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(asdict(self), ensure_ascii=False, indent=2), encoding="utf-8")

    @classmethod
    def load(cls, path: Path) -> "VideoScript":
        return cls(**json.loads(path.read_text(encoding="utf-8")))


def _short_name(name: str, limit: int = 26) -> str:
    """상품명이 너무 길면 내레이션용으로 잘라낸다."""
    cleaned = re.sub(r"[\[\](){}]", " ", name)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    words = cleaned.split(" ")
    out = ""
    for w in words:
        if len(out) + len(w) + 1 > limit:
            break
        out = f"{out} {w}".strip()
    return out or cleaned[:limit]


def _build_description(body: str, p: Product) -> str:
    link = p.deeplink_url or p.product_url
    return f"{body}\n\n🛒 구매 링크: {link}\n\n{DISCLOSURE}"


def template_script(p: Product) -> VideoScript:
    """API 키 없이 동작하는 규칙 기반 대본."""
    name = _short_name(p.name)
    price = f"{p.price:,}원"
    sentences = [
        f"요즘 난리 난 {name}, 아직 모르세요?",
        f"지금 쿠팡에서 단돈 {price}에 살 수 있어요.",
    ]
    if p.is_rocket:
        sentences.append("로켓배송이라 내일 바로 도착합니다.")
    if p.is_free_shipping and not p.is_rocket:
        sentences.append("무료배송이라 부담도 없어요.")
    sentences += [
        "리뷰 확인하고 늦기 전에 챙겨가세요.",
        "구매 링크는 댓글과 더보기란에 있습니다!",
    ]
    tag_src = (p.category or "쇼핑").replace(" ", "")
    hashtags = ["#쿠팡", "#쿠팡추천템", f"#{tag_src}", "#쇼츠", "#내돈내산아님"]
    body = f"{name} 최저가 정보!\n가격: {price}" + (" | 🚀 로켓배송" if p.is_rocket else "")
    return VideoScript(
        product_id=p.product_id,
        title=f"{_short_name(p.name, 20)} {price}, 이 가격 실화? 🔥",
        sentences=sentences,
        hashtags=hashtags,
        description=_build_description(body, p),
        source="template",
    )


def llm_script(p: Product, api_key: str, model: str = "claude-haiku-4-5") -> VideoScript:
    """Claude API로 대본 생성. 실패 시 예외를 던진다 (호출자가 템플릿 폴백)."""
    import anthropic

    client = anthropic.Anthropic(api_key=api_key)
    features = []
    if p.is_rocket:
        features.append("로켓배송")
    if p.is_free_shipping:
        features.append("무료배송")

    prompt = (
        "쿠팡 상품 홍보용 유튜브 쇼츠(30~40초) 내레이션 대본을 한국어로 작성해줘.\n"
        f"- 상품명: {p.name}\n"
        f"- 가격: {p.price:,}원\n"
        f"- 카테고리: {p.category or '일반'}\n"
        f"- 특징: {', '.join(features) or '없음'}\n\n"
        "규칙:\n"
        "- sentences는 5~7개 문장. 각 문장은 TTS로 읽기 좋게 짧고 구어체로.\n"
        "- 첫 문장은 3초 안에 시선을 잡는 후킹 멘트.\n"
        "- 마지막 문장은 '링크는 댓글/더보기에 있다'는 CTA.\n"
        "- 과장 광고 표현(최고, 1위, 완치 등 근거 없는 단정)은 피할 것.\n"
        "- title은 40자 이내로 클릭을 유도하되 낚시성 거짓말은 금지.\n"
        "- hashtags는 5~8개, '#'로 시작.\n"
    )
    response = client.messages.create(
        model=model,
        max_tokens=1024,
        output_config={"format": {"type": "json_schema", "schema": _SCRIPT_SCHEMA}},
        messages=[{"role": "user", "content": prompt}],
    )
    text = next(b.text for b in response.content if b.type == "text")
    data = json.loads(text)
    return VideoScript(
        product_id=p.product_id,
        title=data["title"],
        sentences=data["sentences"],
        hashtags=data["hashtags"],
        description=_build_description(data["description_body"], p),
        source="llm",
    )


def generate_script(p: Product, api_key: str = "", model: str = "claude-haiku-4-5") -> VideoScript:
    """API 키가 있으면 LLM, 없거나 실패하면 템플릿으로 대본 생성."""
    if api_key:
        try:
            return llm_script(p, api_key, model)
        except Exception:
            pass
    return template_script(p)
