import responses

from cmm_auto.collector.partners_api import (
    BASE_URL,
    PartnersApiError,
    PartnersClient,
    generate_signature,
)

SEARCH_PATH = "/v2/providers/affiliate_open_api/apis/openapi/products/search"
DEEPLINK_PATH = "/v2/providers/affiliate_open_api/apis/openapi/deeplink"


def test_generate_signature_is_deterministic():
    auth, signed_date = generate_signature(
        "GET",
        SEARCH_PATH,
        "keyword=%EB%85%B8%ED%8A%B8%EB%B6%81&limit=10",
        secret_key="secret",
        access_key="access",
        signed_date="250101T000000Z",
    )
    assert signed_date == "250101T000000Z"
    assert auth.startswith("CEA algorithm=HmacSHA256, access-key=access, ")
    assert "signed-date=250101T000000Z" in auth
    # 같은 입력이면 같은 서명
    auth2, _ = generate_signature(
        "GET", SEARCH_PATH, "keyword=%EB%85%B8%ED%8A%B8%EB%B6%81&limit=10",
        secret_key="secret", access_key="access", signed_date="250101T000000Z",
    )
    assert auth == auth2


@responses.activate
def test_search_products_parses_product_data():
    responses.add(
        responses.GET,
        BASE_URL + SEARCH_PATH,
        json={
            "rCode": "0",
            "rMessage": "",
            "data": {
                "landingUrl": "https://link.coupang.com/...",
                "productData": [
                    {"productId": 1, "productName": "노트북", "productPrice": 990000},
                ],
            },
        },
    )
    client = PartnersClient("ak", "sk")
    products = client.search_products("노트북", limit=5)
    assert len(products) == 1
    assert products[0]["productId"] == 1
    # 인증 헤더가 붙었는지 확인
    assert responses.calls[0].request.headers["Authorization"].startswith("CEA ")


@responses.activate
def test_api_error_code_raises():
    responses.add(
        responses.GET,
        BASE_URL + SEARCH_PATH,
        json={"rCode": "ERROR", "rMessage": "invalid key"},
    )
    client = PartnersClient("ak", "sk")
    try:
        client.search_products("노트북")
        assert False, "PartnersApiError가 발생해야 함"
    except PartnersApiError as e:
        assert "invalid key" in str(e)


@responses.activate
def test_retry_on_500_then_success():
    responses.add(responses.GET, BASE_URL + SEARCH_PATH, status=500)
    responses.add(
        responses.GET,
        BASE_URL + SEARCH_PATH,
        json={"rCode": "0", "data": {"productData": []}},
    )
    client = PartnersClient("ak", "sk")
    assert client.search_products("키보드") == []
    assert len(responses.calls) == 2


@responses.activate
def test_create_deeplinks_posts_urls():
    responses.add(
        responses.POST,
        BASE_URL + DEEPLINK_PATH,
        json={
            "rCode": "0",
            "data": [
                {
                    "originalUrl": "https://www.coupang.com/vp/products/1",
                    "shortenUrl": "https://link.coupang.com/a/xyz",
                }
            ],
        },
    )
    client = PartnersClient("ak", "sk")
    links = client.create_deeplinks(["https://www.coupang.com/vp/products/1"])
    assert links[0]["shortenUrl"] == "https://link.coupang.com/a/xyz"
