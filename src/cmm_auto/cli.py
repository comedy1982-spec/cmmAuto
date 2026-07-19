"""CLI 진입점: cmm-auto collect / list"""
from __future__ import annotations

import typer

from .config import load_settings
from .db import STATUSES, Database
from .collector.partners_api import PartnersClient
from .collector.service import (
    CollectFilter,
    collect_best_category,
    collect_by_keyword,
    collect_goldbox,
)

app = typer.Typer(help="쿠팡 상품 자동 쇼츠 영상 생성 파이프라인")


def _client_and_db() -> tuple[PartnersClient, Database]:
    settings = load_settings()
    settings.require_coupang_keys()
    client = PartnersClient(settings.coupang_access_key, settings.coupang_secret_key)
    db = Database(settings.db_path)
    return client, db


def _print_result(label: str, r) -> None:
    typer.echo(
        f"[{label}] 조회 {r.fetched}건 → 신규 저장 {r.saved}건 "
        f"(중복 {r.skipped_duplicate}, 필터 제외 {r.skipped_filtered})"
    )


@app.command()
def collect(
    keyword: str = typer.Option(None, "--keyword", "-k", help="검색 키워드"),
    category: int = typer.Option(None, "--category", "-c", help="베스트 카테고리 ID"),
    goldbox: bool = typer.Option(False, "--goldbox", "-g", help="골드박스 특가 수집"),
    limit: int = typer.Option(10, "--limit", "-n", help="수집 개수"),
    min_price: int = typer.Option(0, help="최소 가격 필터"),
    max_price: int = typer.Option(0, help="최대 가격 필터 (0=제한 없음)"),
    rocket_only: bool = typer.Option(False, help="로켓배송 상품만"),
):
    """쿠팡 파트너스 API로 상품을 수집해 DB에 저장한다."""
    if not keyword and category is None and not goldbox:
        typer.echo("--keyword, --category, --goldbox 중 하나 이상을 지정하세요.", err=True)
        raise typer.Exit(1)

    client, db = _client_and_db()
    filters = CollectFilter(min_price=min_price, max_price=max_price, rocket_only=rocket_only)
    with db:
        if keyword:
            _print_result(f"검색:{keyword}", collect_by_keyword(client, db, keyword, limit, filters))
        if category is not None:
            _print_result(f"베스트:{category}", collect_best_category(client, db, category, limit, filters))
        if goldbox:
            _print_result("골드박스", collect_goldbox(client, db, filters))


@app.command()
def generate(
    product_id: int = typer.Option(None, "--id", help="특정 상품 ID만 처리"),
    all_collected: bool = typer.Option(False, "--all", "-a", help="collected 상태 상품 전부 처리"),
    voice: str = typer.Option("ko-KR-SunHiNeural", "--voice", help="Edge TTS 보이스"),
):
    """대본 생성 + TTS 음성 + 자막 생성 (collected → assets_ready)."""
    from .pipeline import run_assets_stage, run_script_stage, product_dir

    settings = load_settings()
    with Database(settings.db_path) as db:
        if product_id is not None:
            targets = [db.get(product_id)] if db.get(product_id) else []
        elif all_collected:
            targets = db.list_products(status="collected", limit=1000)
        else:
            typer.echo("--id 또는 --all 을 지정하세요.", err=True)
            raise typer.Exit(1)

        if not targets:
            typer.echo("처리할 상품이 없습니다. (collected 상태 상품 필요)")
            return

        for p in targets:
            typer.echo(f"▶ {p.product_id} {p.name[:36]}")
            script = run_script_stage(settings, db, p)
            typer.echo(f"  대본({script.source}) {len(script.sentences)}문장 | {script.title}")
            segments = run_assets_stage(settings, db, p, voice=voice)
            total = segments[-1].end if segments else 0.0
            typer.echo(f"  음성 {len(segments)}개 세그먼트, 총 {total:.1f}초 → {product_dir(settings, p.product_id)}")


@app.command()
def render(
    product_id: int = typer.Option(None, "--id", help="특정 상품 ID만 렌더링"),
    all_ready: bool = typer.Option(False, "--all", "-a", help="assets_ready 상태 상품 전부"),
    bgm_dir: str = typer.Option("assets/bgm", "--bgm-dir", help="BGM 디렉터리 (없으면 BGM 생략)"),
):
    """음성+이미지+자막 → 쇼츠 mp4 렌더링 (assets_ready → rendered)."""
    from pathlib import Path
    from .pipeline import product_dir
    from .renderer.ffmpeg_renderer import RenderError, ensure_ffmpeg, render_product

    ensure_ffmpeg()
    settings = load_settings()
    with Database(settings.db_path) as db:
        if product_id is not None:
            targets = [db.get(product_id)] if db.get(product_id) else []
        elif all_ready:
            targets = db.list_products(status="assets_ready", limit=1000)
        else:
            typer.echo("--id 또는 --all 을 지정하세요.", err=True)
            raise typer.Exit(1)

        if not targets:
            typer.echo("렌더링할 상품이 없습니다. (assets_ready 상태 상품 필요)")
            return

        for p in targets:
            typer.echo(f"▶ {p.product_id} {p.name[:36]}")
            try:
                out = render_product(product_dir(settings, p.product_id), bgm_dir=Path(bgm_dir))
            except RenderError as e:
                typer.echo(f"  ✗ 렌더링 실패: {e}", err=True)
                continue
            db.set_status(p.product_id, "rendered")
            typer.echo(f"  ✓ {out}")


@app.command("list")
def list_cmd(
    status: str = typer.Option(None, "--status", "-s", help=f"상태 필터 {STATUSES}"),
    limit: int = typer.Option(30, "--limit", "-n"),
):
    """저장된 상품 리스트를 출력한다."""
    settings = load_settings()
    with Database(settings.db_path) as db:
        products = db.list_products(status=status, limit=limit)
        if not products:
            typer.echo("저장된 상품이 없습니다.")
            return
        for p in products:
            rocket = "🚀" if p.is_rocket else "  "
            typer.echo(
                f"{p.product_id:>13} | {p.status:<12} | {p.price:>10,}원 {rocket} | "
                f"{p.name[:40]}"
            )


if __name__ == "__main__":
    app()
