from cmm_auto.db import Product
from cmm_auto.scriptwriter.generator import (
    DISCLOSURE,
    VideoScript,
    generate_script,
    template_script,
)


def make_product(**kw) -> Product:
    defaults = dict(
        product_id=1,
        name="삼성 갤럭시 버즈3 프로 무선 이어폰 [사은품 증정]",
        price=189000,
        image_url="https://img.example.com/1.jpg",
        product_url="https://www.coupang.com/vp/products/1",
        deeplink_url="https://link.coupang.com/a/abc",
        category="이어폰",
        is_rocket=True,
        source="search:이어폰",
    )
    defaults.update(kw)
    return Product(**defaults)


def test_template_script_structure():
    s = template_script(make_product())
    assert 4 <= len(s.sentences) <= 7
    assert "189,000원" in " ".join(s.sentences)
    assert any("로켓배송" in x for x in s.sentences)
    assert s.sentences[-1].endswith("!")  # CTA
    assert s.source == "template"


def test_description_contains_deeplink_and_disclosure():
    s = template_script(make_product())
    assert "https://link.coupang.com/a/abc" in s.description
    assert DISCLOSURE in s.description


def test_description_falls_back_to_product_url():
    s = template_script(make_product(deeplink_url=None))
    assert "https://www.coupang.com/vp/products/1" in s.description


def test_generate_script_without_key_uses_template():
    s = generate_script(make_product(), api_key="")
    assert s.source == "template"


def test_script_save_and_load(tmp_path):
    s = template_script(make_product())
    path = tmp_path / "script.json"
    s.save(path)
    loaded = VideoScript.load(path)
    assert loaded == s
