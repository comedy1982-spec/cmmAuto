"""백그라운드 작업(영상 생성) 관리.

웹 요청은 즉시 job_id를 돌려주고, 실제 파이프라인은 워커 스레드에서 돈다.
브라우저는 /api/jobs/{id} 를 폴링해 진행 상황을 표시한다.
"""
from __future__ import annotations

import threading
import traceback
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from ..config import load_settings
from ..db import Database
from ..pipeline import product_dir, run_assets_stage, run_script_stage
from ..renderer.ffmpeg_renderer import render_product

STEP_LABELS = ["대본 작성", "음성·자막 생성", "영상 렌더링"]


@dataclass
class Job:
    id: str
    product_id: int
    product_name: str
    status: str = "running"          # running | done | error
    step: int = 0                    # 완료된 단계 수 (0~3)
    logs: list[str] = field(default_factory=list)
    error: str | None = None
    video_url: str | None = None
    created_at: str = field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat(timespec="seconds")
    )

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "product_id": self.product_id,
            "product_name": self.product_name,
            "status": self.status,
            "step": self.step,
            "total_steps": len(STEP_LABELS),
            "step_labels": STEP_LABELS,
            "logs": self.logs,
            "error": self.error,
            "video_url": self.video_url,
            "created_at": self.created_at,
        }


class JobManager:
    def __init__(self) -> None:
        self._jobs: dict[str, Job] = {}
        self._lock = threading.Lock()
        self._active_products: set[int] = set()

    def get(self, job_id: str) -> Job | None:
        with self._lock:
            return self._jobs.get(job_id)

    def list_jobs(self, limit: int = 20) -> list[Job]:
        with self._lock:
            return sorted(self._jobs.values(), key=lambda j: j.created_at, reverse=True)[:limit]

    def is_running(self, product_id: int) -> bool:
        with self._lock:
            return product_id in self._active_products

    def start(self, product_id: int, product_name: str, voice: str, bgm_dir: str) -> Job:
        job = Job(id=uuid.uuid4().hex[:12], product_id=product_id, product_name=product_name)
        with self._lock:
            self._jobs[job.id] = job
            self._active_products.add(product_id)
        threading.Thread(
            target=self._run, args=(job, voice, bgm_dir), daemon=True
        ).start()
        return job

    def _log(self, job: Job, message: str) -> None:
        with self._lock:
            job.logs.append(message)

    def _run(self, job: Job, voice: str, bgm_dir: str) -> None:
        settings = load_settings()
        try:
            with Database(settings.db_path) as db:
                product = db.get(job.product_id)
                if product is None:
                    raise RuntimeError("상품을 찾을 수 없습니다.")

                script = run_script_stage(settings, db, product)
                source = "AI" if script.source == "llm" else "기본 템플릿"
                self._log(job, f"대본 완성 ({source}, {len(script.sentences)}문장): {script.title}")
                job.step = 1

                segments = run_assets_stage(settings, db, product, voice=voice)
                length = segments[-1].end if segments else 0.0
                self._log(job, f"음성·자막 완성 ({len(segments)}문장, 약 {length:.1f}초)")
                job.step = 2

                bgm_path = Path(bgm_dir) if bgm_dir else None
                out = render_product(product_dir(settings, job.product_id), bgm_dir=bgm_path)
                db.set_status(job.product_id, "rendered")
                self._log(job, f"영상 완성: {out.name}")
                job.step = 3
                job.video_url = f"/api/products/{job.product_id}/video"
                job.status = "done"
        except Exception as e:
            job.status = "error"
            job.error = str(e) or f"{type(e).__name__}"
            self._log(job, f"오류: {job.error}")
            traceback.print_exc()
        finally:
            with self._lock:
                self._active_products.discard(job.product_id)


manager = JobManager()
