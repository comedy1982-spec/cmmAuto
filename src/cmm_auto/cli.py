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
