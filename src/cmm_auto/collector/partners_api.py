"""쿠팡 파트너스 Open API 클라이언트.

인증: HMAC-SHA256 서명 (CEA 방식)
문서: https://developers.coupangcorp.com/hc/ko (파트너스 Open API)
"""
from __future__ import annotations

import hashlib
import hmac
import json
import time
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlencode

import requests

BASE_URL = "https://api-gateway.coupang.com"
_API_PREFIX = "/v2/providers/affiliate_open_api/apis/openapi"


class PartnersApiError(RuntimeError):
    pass


def generate_signature(
    method: str,
    path: str,
    query: str,
    secret_key: str,
    access_key: str,
    signed_date: str | None = None,
) -> tuple[str, str]:
    """CEA HMAC 서명과 Authorization 헤더 값을 생성한다.

    signed_date 형식: yyMMdd'T'HHmmss'Z' (UTC)
    서명 대상 메시지: signed_date + method + path + query
    """
    if signed_date is None:
        signed_date = datetime.now(timezone.utc).strftime("%y%m%dT%H%M%SZ")
    message = signed_date + method + path + query
    signature = hmac.new(
        secret_key.encode("utf-8"), message.encode("utf-8"), hashlib.sha256
    ).hexdigest()
    authorization = (
        f"CEA algorithm=HmacSHA256, access-key={access_key}, "
        f"signed-date={signed_date}, signature={signature}"
    )
    return authorization, signed_date


class PartnersClient:
    def __init__(
        self,
        access_key: str,
        secret_key: str,
        session: requests.Session | None = None,
        max_retries: int = 3,
    ):
        self.access_key = access_key
        self.secret_key = secret_key
        self.session = session or requests.Session()
        self.max_retries = max_retries

    def _request(
        self,
        method: str,
        path: str,
        params: dict[str, Any] | None = None,
        body: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        query = urlencode(params, doseq=True) if params else ""
        url = BASE_URL + path + (f"?{query}" if query else "")

        last_error: Exception | None = None
        for attempt in range(self.max_retries):
            authorization, _ = generate_signature(
                method, path, query, self.secret_key, self.access_key
            )
            headers = {
                "Authorization": authorization,
                "Content-Type": "application/json;charset=UTF-8",
            }
            try:
                resp = self.session.request(
                    method,
                    url,
                    headers=headers,
                    data=json.dumps(body) if body is not None else None,
                    timeout=15,
                )
            except requests.RequestException as e:
                last_error = e
                time.sleep(2**attempt)
                continue

            if resp.status_code == 429 or resp.status_code >= 500:
                last_error = PartnersApiError(
                    f"HTTP {resp.status_code}: {resp.text[:200]}"
                )
                time.sleep(2**attempt)
                continue
            if resp.status_code != 200:
                raise PartnersApiError(f"HTTP {resp.status_code}: {resp.text[:500]}")

            payload = resp.json()
            rcode = str(payload.get("rCode", payload.get("rOCode", "0")))
            if rcode not in ("0", "RC-0000"):
                raise PartnersApiError(
                    f"API 오류 rCode={rcode}: {payload.get('rMessage', '')}"
                )
            return payload

        raise PartnersApiError(f"요청 재시도 초과: {last_error}")

    def search_products(self, keyword: str, limit: int = 10) -> list[dict[str, Any]]:
        """키워드로 상품 검색."""
        payload = self._request(
            "GET",
            f"{_API_PREFIX}/products/search",
            params={"keyword": keyword, "limit": limit},
        )
        data = payload.get("data") or {}
        return data.get("productData") or []

    def best_category_products(
        self, category_id: int, limit: int = 10
    ) -> list[dict[str, Any]]:
        """카테고리 베스트 상품 조회."""
        payload = self._request(
            "GET",
            f"{_API_PREFIX}/products/bestcategories/{category_id}",
            params={"limit": limit},
        )
        return payload.get("data") or []

    def goldbox_products(self) -> list[dict[str, Any]]:
        """골드박스(오늘의 특가) 상품 조회."""
        payload = self._request("GET", f"{_API_PREFIX}/products/goldbox")
        return payload.get("data") or []

    def create_deeplinks(self, urls: list[str]) -> list[dict[str, Any]]:
        """상품 URL을 제휴 딥링크로 변환."""
        payload = self._request(
            "POST",
            f"{_API_PREFIX}/deeplink",
            body={"coupangUrls": urls},
        )
        return payload.get("data") or []
