"""SQLite 저장소: 상품 및 파이프라인 상태 관리.

상태 흐름: collected → scripted → assets_ready → rendered → uploaded
"""
from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

STATUSES = ("collected", "scripted", "assets_ready", "rendered", "uploaded")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS products (
    product_id      INTEGER PRIMARY KEY,
    name            TEXT NOT NULL,
    price           INTEGER NOT NULL,
    image_url       TEXT NOT NULL,
    product_url     TEXT NOT NULL,
    deeplink_url    TEXT,
    category        TEXT,
    is_rocket       INTEGER NOT NULL DEFAULT 0,
    is_free_shipping INTEGER NOT NULL DEFAULT 0,
    source          TEXT NOT NULL,           -- search:<keyword> | best:<categoryId> | goldbox
    status          TEXT NOT NULL DEFAULT 'collected',
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_products_status ON products(status);
"""


@dataclass
class Product:
    product_id: int
    name: str
    price: int
    image_url: str
    product_url: str
    deeplink_url: str | None = None
    category: str | None = None
    is_rocket: bool = False
    is_free_shipping: bool = False
    source: str = ""
    status: str = "collected"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Database:
    def __init__(self, path: Path | str):
        self.path = Path(path)
        if str(self.path) != ":memory:":
            self.path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(self.path)
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript(_SCHEMA)

    def close(self) -> None:
        self.conn.close()

    def __enter__(self) -> "Database":
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    def upsert_product(self, p: Product) -> bool:
        """상품 저장. 신규 저장이면 True, 이미 존재하면 False (기존 상태 보존)."""
        now = _now()
        is_new = not self.exists(p.product_id)
        self.conn.execute(
            """
            INSERT INTO products (product_id, name, price, image_url, product_url,
                                  deeplink_url, category, is_rocket, is_free_shipping,
                                  source, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'collected', ?, ?)
            ON CONFLICT(product_id) DO UPDATE SET
                name = excluded.name,
                price = excluded.price,
                image_url = excluded.image_url,
                product_url = excluded.product_url,
                deeplink_url = COALESCE(excluded.deeplink_url, products.deeplink_url),
                updated_at = excluded.updated_at
            """,
            (
                p.product_id, p.name, p.price, p.image_url, p.product_url,
                p.deeplink_url, p.category, int(p.is_rocket), int(p.is_free_shipping),
                p.source, now, now,
            ),
        )
        self.conn.commit()
        return is_new

    def set_status(self, product_id: int, status: str) -> None:
        if status not in STATUSES:
            raise ValueError(f"알 수 없는 상태: {status}")
        self.conn.execute(
            "UPDATE products SET status = ?, updated_at = ? WHERE product_id = ?",
            (status, _now(), product_id),
        )
        self.conn.commit()

    def set_deeplink(self, product_id: int, deeplink_url: str) -> None:
        self.conn.execute(
            "UPDATE products SET deeplink_url = ?, updated_at = ? WHERE product_id = ?",
            (deeplink_url, _now(), product_id),
        )
        self.conn.commit()

    def get(self, product_id: int) -> Product | None:
        row = self.conn.execute(
            "SELECT * FROM products WHERE product_id = ?", (product_id,)
        ).fetchone()
        return self._to_product(row) if row else None

    def list_products(self, status: str | None = None, limit: int = 50) -> list[Product]:
        if status:
            rows = self.conn.execute(
                "SELECT * FROM products WHERE status = ? ORDER BY updated_at DESC LIMIT ?",
                (status, limit),
            ).fetchall()
        else:
            rows = self.conn.execute(
                "SELECT * FROM products ORDER BY updated_at DESC LIMIT ?", (limit,)
            ).fetchall()
        return [self._to_product(r) for r in rows]

    def delete(self, product_id: int) -> bool:
        cur = self.conn.execute("DELETE FROM products WHERE product_id = ?", (product_id,))
        self.conn.commit()
        return cur.rowcount > 0

    def exists(self, product_id: int) -> bool:
        return self.conn.execute(
            "SELECT 1 FROM products WHERE product_id = ?", (product_id,)
        ).fetchone() is not None

    @staticmethod
    def _to_product(row: sqlite3.Row) -> Product:
        return Product(
            product_id=row["product_id"],
            name=row["name"],
            price=row["price"],
            image_url=row["image_url"],
            product_url=row["product_url"],
            deeplink_url=row["deeplink_url"],
            category=row["category"],
            is_rocket=bool(row["is_rocket"]),
            is_free_shipping=bool(row["is_free_shipping"]),
            source=row["source"],
            status=row["status"],
        )
