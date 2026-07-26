import json

import pytest
from fastapi.testclient import TestClient

from cmm_auto.db import Database, Product
from cmm_auto.web import app as web_app


@pytest.fixture
def client(tmp_path, monkeypatch):
    """DB와 출력 경로를 임시 디렉터리로 돌린 테스트 클라이언트."""
    from cmm_auto.config import Settings

    settings = Settings(db_path=tmp_path / "test.db", output_dir=tmp_path / "out")
    monkeypatch.setattr(web_app, "_settings", lambda: settings)
    with Database(settings.db_path) as db:
        db.upsert_product(
            Product(
                product_id=111,
                name="테스트 상품",
                price=19900,
                image_url="https://img.example.com/a.jpg",
                product_url="https://www.coupang.com/vp/products/111",
                category="가전",
                is_rocket=True,
                source="web",
            )
        )
    yield TestClient(web_app.app), settings


def test_index_serves_html(client):
    c, _ = client
    r = c.get("/")
    assert r.status_code == 200
    assert "cmmAuto" in r.text


def test_status_reports_environment(client):
    c, _ = client
    body = c.get("/api/status").json()
    assert set(body) == {"ffmpeg", "coupang_api", "anthropic_api"}
    assert isinstance(body["ffmpeg"], bool)


def test_list_products(client):
    c, _ = client
    items = c.get("/api/products").json()
    assert len(items) == 1
    assert items[0]["name"] == "테스트 상품"
    assert items[0]["status_label"] == "대기 중"
    assert items[0]["has_video"] is False


def test_add_product_extracts_id_from_url(client):
    c, _ = client
    r = c.post("/api/products", json={
        "url": "https://www.coupang.com/vp/products/8899?itemId=1",
        "name": "새 상품", "price": 5000, "image_url": "https://img/x.jpg",
    })
    assert r.status_code == 201
    assert r.json()["product_id"] == 8899


def test_add_product_without_id_in_url_still_works(client):
    c, _ = client
    r = c.post("/api/products", json={
        "url": "https://link.coupang.com/a/abcd",
        "name": "짧은링크 상품", "price": 1000, "image_url": "https://img/y.jpg",
    })
    assert r.status_code == 201
    assert r.json()["product_id"] > 0


def test_add_product_rejects_invalid_price(client):
    c, _ = client
    r = c.post("/api/products", json={
        "url": "https://x/products/1", "name": "n", "price": -5, "image_url": "i",
    })
    assert r.status_code == 422


def test_delete_product_removes_row_and_files(client):
    c, settings = client
    pdir = settings.output_dir / "111"
    pdir.mkdir(parents=True)
    (pdir / "final.mp4").write_bytes(b"video")

    assert c.delete("/api/products/111").status_code == 200
    assert c.get("/api/products").json() == []
    assert not pdir.exists()


def test_delete_missing_product_404(client):
    c, _ = client
    assert c.delete("/api/products/404404").status_code == 404


def test_video_404_before_render(client):
    c, _ = client
    assert c.get("/api/products/111/video").status_code == 404


def test_video_and_meta_served_after_render(client):
    c, settings = client
    pdir = settings.output_dir / "111"
    pdir.mkdir(parents=True)
    (pdir / "final.mp4").write_bytes(b"fake-mp4-bytes")
    (pdir / "meta.json").write_text(
        json.dumps({"title": "제목", "hashtags": ["#a"]}, ensure_ascii=False), encoding="utf-8"
    )

    r = c.get("/api/products/111/video")
    assert r.status_code == 200 and r.content == b"fake-mp4-bytes"
    assert c.get("/api/products/111/meta").json()["title"] == "제목"
    assert c.get("/api/products").json()[0]["has_video"] is True


def test_run_missing_product_404(client, monkeypatch):
    c, _ = client
    monkeypatch.setattr(web_app.shutil, "which", lambda _: "/usr/bin/ffmpeg")
    assert c.post("/api/products/404404/run", json={}).status_code == 404


def test_run_requires_ffmpeg(client, monkeypatch):
    c, _ = client
    monkeypatch.setattr(web_app.shutil, "which", lambda _: None)
    r = c.post("/api/products/111/run", json={})
    assert r.status_code == 400
    assert "ffmpeg" in r.json()["detail"]


def test_job_not_found(client):
    c, _ = client
    assert c.get("/api/jobs/nope").status_code == 404
