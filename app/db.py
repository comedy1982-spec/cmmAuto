"""SQLite 캔들 저장소. 타임스탬프는 밀리초(UTC) 기준으로 저장한다."""
from __future__ import annotations

from pathlib import Path

import aiosqlite

SCHEMA = """
CREATE TABLE IF NOT EXISTS candles (
    exchange  TEXT    NOT NULL,
    symbol    TEXT    NOT NULL,
    timeframe TEXT    NOT NULL,
    ts        INTEGER NOT NULL,
    open      REAL    NOT NULL,
    high      REAL    NOT NULL,
    low       REAL    NOT NULL,
    close     REAL    NOT NULL,
    volume    REAL    NOT NULL,
    PRIMARY KEY (exchange, symbol, timeframe, ts)
);

CREATE TABLE IF NOT EXISTS layouts (
    name       TEXT PRIMARY KEY,
    data       TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
"""


class Database:
    def __init__(self, path: Path):
        self.path = path
        self._conn: aiosqlite.Connection | None = None

    async def init(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = await aiosqlite.connect(self.path)
        await self._conn.execute("PRAGMA journal_mode=WAL")
        await self._conn.execute("PRAGMA synchronous=NORMAL")
        await self._conn.executescript(SCHEMA)
        await self._conn.commit()

    async def close(self) -> None:
        if self._conn:
            await self._conn.close()
            self._conn = None

    @property
    def conn(self) -> aiosqlite.Connection:
        assert self._conn is not None, "Database.init() must be called first"
        return self._conn

    async def upsert_candles(
        self, exchange: str, symbol: str, timeframe: str, rows: list[list[float]]
    ) -> None:
        """rows: ccxt fetch_ohlcv 결과 [[ts, o, h, l, c, v], ...]"""
        if not rows:
            return
        await self.conn.executemany(
            "INSERT OR REPLACE INTO candles VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [
                (exchange, symbol, timeframe, int(r[0]), r[1], r[2], r[3], r[4], r[5] or 0)
                for r in rows
                if r[1] is not None
            ],
        )
        await self.conn.commit()

    async def last_timestamp(self, exchange: str, symbol: str, timeframe: str) -> int | None:
        async with self.conn.execute(
            "SELECT MAX(ts) FROM candles WHERE exchange=? AND symbol=? AND timeframe=?",
            (exchange, symbol, timeframe),
        ) as cur:
            row = await cur.fetchone()
        return row[0] if row and row[0] is not None else None

    async def get_candles(
        self,
        exchange: str,
        symbol: str,
        timeframe: str,
        limit: int = 500,
        before_ms: int | None = None,
    ) -> list[dict]:
        """오름차순 캔들 목록. before_ms가 주어지면 그 이전(미포함) 캔들만."""
        sql = "SELECT ts, open, high, low, close, volume FROM candles WHERE exchange=? AND symbol=? AND timeframe=?"
        params: list = [exchange, symbol, timeframe]
        if before_ms is not None:
            sql += " AND ts < ?"
            params.append(before_ms)
        sql += " ORDER BY ts DESC LIMIT ?"
        params.append(limit)

        async with self.conn.execute(sql, params) as cur:
            rows = await cur.fetchall()

        return [
            {"time": r[0] // 1000, "open": r[1], "high": r[2], "low": r[3], "close": r[4], "volume": r[5]}
            for r in reversed(rows)
        ]

    async def candle_count(self, exchange: str, symbol: str, timeframe: str) -> int:
        async with self.conn.execute(
            "SELECT COUNT(*) FROM candles WHERE exchange=? AND symbol=? AND timeframe=?",
            (exchange, symbol, timeframe),
        ) as cur:
            row = await cur.fetchone()
        return row[0] if row else 0

    async def distinct_symbols(self, exchange: str) -> list[str]:
        async with self.conn.execute(
            "SELECT DISTINCT symbol FROM candles WHERE exchange=?", (exchange,)
        ) as cur:
            rows = await cur.fetchall()
        return [r[0] for r in rows]

    # ----- 키-값 설정 (스캐너 등) -----

    async def get_setting(self, key: str) -> str | None:
        async with self.conn.execute("SELECT value FROM settings WHERE key=?", (key,)) as cur:
            row = await cur.fetchone()
        return row[0] if row else None

    async def save_setting(self, key: str, value: str) -> None:
        await self.conn.execute(
            "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, strftime('%s','now'))",
            (key, value),
        )
        await self.conn.commit()

    # ----- 차트 레이아웃 프리셋 -----

    async def save_layout(self, name: str, data_json: str) -> None:
        await self.conn.execute(
            "INSERT OR REPLACE INTO layouts (name, data, updated_at) VALUES (?, ?, strftime('%s','now'))",
            (name, data_json),
        )
        await self.conn.commit()

    async def list_layouts(self) -> list[dict]:
        async with self.conn.execute(
            "SELECT name, updated_at FROM layouts ORDER BY updated_at DESC"
        ) as cur:
            rows = await cur.fetchall()
        return [{"name": r[0], "updated_at": r[1]} for r in rows]

    async def get_layout(self, name: str) -> str | None:
        async with self.conn.execute("SELECT data FROM layouts WHERE name=?", (name,)) as cur:
            row = await cur.fetchone()
        return row[0] if row else None

    async def delete_layout(self, name: str) -> bool:
        cur = await self.conn.execute("DELETE FROM layouts WHERE name=?", (name,))
        await self.conn.commit()
        return cur.rowcount > 0
