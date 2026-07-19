from unittest.mock import MagicMock

from cmm_auto.db import Database
from cmm_auto.collector.service import CollectFilter, collect_products


def raw_product(pid=1, price=10000, rocket=True):
    return {
        "productId": pid,
        "productName": f"상품 {pid}",
        "productPrice": price,
        "productImage": f"https://img.example.com/{pid}.jpg",
        "productUrl": f"https://www.coupang.com/vp/products/{pid}",
        "categoryName": "가전",
        "isRocket": rocket,
        "isFreeShipping": True,
    }


def make_client(deeplinks=None):
    client = MagicMock()
    client.create_deeplinks.return_value = deeplinks or []
    return client


def test_collect_saves_new_products(tmp_path):
    client = make_client(
        deeplinks=[
            {
                "originalUrl": "https://www.coupang.com/vp/products/1",
                "shortenUrl": "https://link.coupang.com/a/one",
            }
        ]
    )
    with Database(tmp_path / "t.db") as db:
        r = collect_products(client, db, [raw_product(1)], source="search:테스트")
        assert r.saved == 1
        p = db.get(1)
        assert p.deeplink_url == "https://link.coupang.com/a/one"
        assert p.status == "collected"


def test_collect_skips_duplicates_without_deeplink_call(tmp_path):
    client = make_client()
    with Database(tmp_path / "t.db") as db:
        collect_products(client, db, [raw_product(1)], source="goldbox")
        client.create_deeplinks.reset_mock()
        r = collect_products(client, db, [raw_product(1)], source="goldbox")
        assert r.saved == 0
        assert r.skipped_duplicate == 1
        client.create_deeplinks.assert_not_called()


def test_collect_applies_filters(tmp_path):
    client = make_client()
    with Database(tmp_path / "t.db") as db:
        r = collect_products(
            client,
            db,
            [raw_product(1, price=5000), raw_product(2, price=50000, rocket=False)],
            source="search:필터",
            filters=CollectFilter(min_price=10000, rocket_only=True),
        )
        assert r.saved == 0
        assert r.skipped_filtered == 2


def test_collect_skips_malformed_rows(tmp_path):
    client = make_client()
    with Database(tmp_path / "t.db") as db:
        r = collect_products(
            client, db, [{"productId": "abc"}], source="search:깨진데이터"
        )
        assert r.saved == 0
        assert r.skipped_filtered == 1
