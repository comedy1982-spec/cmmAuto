from cmm_auto.db import Database, Product


def make_product(pid=1001, **kw) -> Product:
    defaults = dict(
        product_id=pid,
        name="테스트 상품",
        price=19900,
        image_url="https://img.example.com/1.jpg",
        product_url="https://www.coupang.com/vp/products/1001",
        source="search:테스트",
    )
    defaults.update(kw)
    return Product(**defaults)


def test_upsert_new_and_duplicate(tmp_path):
    with Database(tmp_path / "t.db") as db:
        assert db.upsert_product(make_product()) is True
        assert db.upsert_product(make_product()) is False
        assert db.exists(1001)


def test_duplicate_preserves_status(tmp_path):
    with Database(tmp_path / "t.db") as db:
        db.upsert_product(make_product())
        db.set_status(1001, "rendered")
        db.upsert_product(make_product(price=15000))
        p = db.get(1001)
        assert p.status == "rendered"
        assert p.price == 15000


def test_duplicate_preserves_deeplink_when_new_is_none(tmp_path):
    with Database(tmp_path / "t.db") as db:
        db.upsert_product(make_product(deeplink_url="https://link.coupang.com/a/abc"))
        db.upsert_product(make_product(deeplink_url=None))
        assert db.get(1001).deeplink_url == "https://link.coupang.com/a/abc"


def test_list_by_status(tmp_path):
    with Database(tmp_path / "t.db") as db:
        db.upsert_product(make_product(1))
        db.upsert_product(make_product(2))
        db.set_status(2, "scripted")
        assert [p.product_id for p in db.list_products(status="collected")] == [1]
        assert [p.product_id for p in db.list_products(status="scripted")] == [2]
        assert len(db.list_products()) == 2


def test_set_status_rejects_unknown(tmp_path):
    with Database(tmp_path / "t.db") as db:
        db.upsert_product(make_product())
        try:
            db.set_status(1001, "nope")
            assert False, "ValueError가 발생해야 함"
        except ValueError:
            pass
