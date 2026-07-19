"""상품 수집 서비스: API 응답 → 필터링 → 딥링크 발급 → DB 저장."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from ..db import Database, Product
from .partners_api import PartnersClient


@dataclass
class CollectFilter:
    min_price: int = 0
    max_price: int = 0          # 0이면 제한 없음
    rocket_only: bool = False


@dataclass
class CollectResult:
    fetched: int = 0
    saved: int = 0
    skipped_duplicate: int = 0
    skipped_filtered: int = 0


def _parse_product(raw: dict[str, Any], source: str) -> Product | None:
    try:
        return Product(
            product_id=int(raw["productId"]),
            name=str(raw["productName"]),
            price=int(raw["productPrice"]),
            image_url=str(raw["productImage"]),
            product_url=str(raw["productUrl"]),
            category=raw.get("categoryName"),
            is_rocket=bool(raw.get("isRocket", False)),
            is_free_shipping=bool(raw.get("isFreeShipping", False)),
            source=source,
        )
    except (KeyError, TypeError, ValueError):
        return None


def _passes(p: Product, f: CollectFilter) -> bool:
    if f.rocket_only and not p.is_rocket:
        return False
    if p.price < f.min_price:
        return False
    if f.max_price and p.price > f.max_price:
        return False
    return True


def collect_products(
    client: PartnersClient,
    db: Database,
    raw_products: list[dict[str, Any]],
    source: str,
    filters: CollectFilter | None = None,
    with_deeplink: bool = True,
) -> CollectResult:
    filters = filters or CollectFilter()
    result = CollectResult(fetched=len(raw_products))

    new_products: list[Product] = []
    for raw in raw_products:
        p = _parse_product(raw, source)
        if p is None:
            result.skipped_filtered += 1
            continue
        if not _passes(p, filters):
            result.skipped_filtered += 1
            continue
        if db.exists(p.product_id):
            result.skipped_duplicate += 1
            continue
        new_products.append(p)

    # 신규 상품만 딥링크 발급 (API 호출 최소화, 최대 50개 단위)
    if with_deeplink and new_products:
        url_map: dict[str, str] = {}
        urls = [p.product_url for p in new_products]
        for i in range(0, len(urls), 50):
            for item in client.create_deeplinks(urls[i : i + 50]):
                original = item.get("originalUrl", "")
                shorten = item.get("shortenUrl") or item.get("landingUrl", "")
                if original and shorten:
                    url_map[original] = shorten
        for p in new_products:
            p.deeplink_url = url_map.get(p.product_url)

    for p in new_products:
        if db.upsert_product(p):
            result.saved += 1
        else:
            result.skipped_duplicate += 1

    return result


def collect_by_keyword(
    client: PartnersClient,
    db: Database,
    keyword: str,
    limit: int = 10,
    filters: CollectFilter | None = None,
) -> CollectResult:
    raw = client.search_products(keyword, limit=limit)
    return collect_products(client, db, raw, source=f"search:{keyword}", filters=filters)


def collect_best_category(
    client: PartnersClient,
    db: Database,
    category_id: int,
    limit: int = 10,
    filters: CollectFilter | None = None,
) -> CollectResult:
    raw = client.best_category_products(category_id, limit=limit)
    return collect_products(client, db, raw, source=f"best:{category_id}", filters=filters)


def collect_goldbox(
    client: PartnersClient,
    db: Database,
    filters: CollectFilter | None = None,
) -> CollectResult:
    raw = client.goldbox_products()
    return collect_products(client, db, raw, source="goldbox", filters=filters)
