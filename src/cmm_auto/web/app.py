"""웹 UI 백엔드 (FastAPI).

로컬 실행 전용 — 인증이 없으므로 외부에 공개하지 마세요.
"""
from __future__ import annotations

import json
import re
import shutil
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, HTMLResponse
from pydantic import BaseModel, Field

from ..config import load_settings
from ..db import Database, Product
from ..pipeline import product_dir
from .jobs import manager

STATUS_LABELS = {
    "collected": "대기 중",
    "scripted": "대본 완료",
    "assets_ready": "음성 완료",
    "rendered": "영상 완성",
    "uploaded": "업로드 완료",
}

app = FastAPI(title="cmmAuto", docs_url=None, redoc_url=None)
_STATIC = Path(__file__).parent / "static"


class ProductIn(BaseModel):
    url: str = Field(min_length=1)
    name: str = Field(min_length=1)
    price: int = Field(ge=0)
    image_url: str = Field(min_length=1)
    category: str = "쇼핑"
    is_rocket: bool = False
    deeplink_url: str | None = None


class RunIn(BaseModel):
    voice: str = "ko-KR-SunHiNeural"
    bgm_dir: str = "assets/bgm"


def _settings():
    return load_settings()


def _product_json(p: Product, settings) -> dict:
    pdir = product_dir(settings, p.product_id)
    video = pdir / "final.mp4"
    return {
        "product_id": p.product_id,
        "name": p.name,
        "price": p.price,
        "image_url": p.image_url,
        "product_url": p.product_url,
        "deeplink_url": p.deeplink_url,
        "category": p.category,
        "is_rocket": p.is_rocket,
        "status": p.status,
        "status_label": STATUS_LABELS.get(p.status, p.status),
        "source": p.source,
        "has_video": video.exists(),
        "running": manager.is_running(p.product_id),
    }


@app.get("/", response_class=HTMLResponse)
def index() -> str:
    return (_STATIC / "index.html").read_text(encoding="utf-8")


@app.get("/api/status")
def api_status() -> dict:
    s = _settings()
    return {
        "ffmpeg": shutil.which("ffmpeg") is not None,
        "coupang_api": bool(s.coupang_access_key and s.coupang_secret_key),
        "anthropic_api": bool(s.anthropic_api_key),
    }


@app.get("/api/products")
def list_products() -> list[dict]:
    s = _settings()
    with Database(s.db_path) as db:
        return [_product_json(p, s) for p in db.list_products(limit=200)]


@app.post("/api/products", status_code=201)
def add_product(body: ProductIn) -> dict:
    s = _settings()
    m = re.search(r"/products/(\d+)", body.url)
    product_id = int(m.group(1)) if m else int(time.time() * 1000) % 10_000_000_000

    with Database(s.db_path) as db:
        db.upsert_product(
            Product(
                product_id=product_id,
                name=body.name,
                price=body.price,
                image_url=body.image_url,
                product_url=body.url,
                deeplink_url=body.deeplink_url,
                category=body.category or "쇼핑",
                is_rocket=body.is_rocket,
                source="web",
            )
        )
        return _product_json(db.get(product_id), s)


@app.delete("/api/products/{product_id}")
def delete_product(product_id: int) -> dict:
    s = _settings()
    if manager.is_running(product_id):
        raise HTTPException(409, "영상 생성 중인 상품은 삭제할 수 없습니다.")
    with Database(s.db_path) as db:
        if not db.delete(product_id):
            raise HTTPException(404, "상품을 찾을 수 없습니다.")
    shutil.rmtree(product_dir(s, product_id), ignore_errors=True)
    return {"deleted": product_id}


@app.post("/api/products/{product_id}/run")
def run_product(product_id: int, body: RunIn) -> dict:
    s = _settings()
    if not shutil.which("ffmpeg"):
        raise HTTPException(400, "ffmpeg가 설치되어 있지 않습니다. 설치 후 다시 시도하세요.")
    if manager.is_running(product_id):
        raise HTTPException(409, "이미 생성 중입니다.")
    with Database(s.db_path) as db:
        product = db.get(product_id)
        if product is None:
            raise HTTPException(404, "상품을 찾을 수 없습니다.")
    job = manager.start(product_id, product.name, body.voice, body.bgm_dir)
    return job.to_dict()


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str) -> dict:
    job = manager.get(job_id)
    if job is None:
        raise HTTPException(404, "작업을 찾을 수 없습니다.")
    return job.to_dict()


@app.get("/api/products/{product_id}/video")
def get_video(product_id: int) -> FileResponse:
    path = product_dir(_settings(), product_id) / "final.mp4"
    if not path.exists():
        raise HTTPException(404, "아직 영상이 없습니다.")
    return FileResponse(path, media_type="video/mp4")


@app.get("/api/products/{product_id}/meta")
def get_meta(product_id: int) -> dict:
    path = product_dir(_settings(), product_id) / "meta.json"
    if not path.exists():
        raise HTTPException(404, "메타데이터가 없습니다.")
    return json.loads(path.read_text(encoding="utf-8"))


def serve(host: str = "127.0.0.1", port: int = 8000, reload: bool = False) -> None:
    import uvicorn

    uvicorn.run("cmm_auto.web.app:app", host=host, port=port, reload=reload, log_level="warning")
