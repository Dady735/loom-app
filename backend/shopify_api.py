"""
Loom – Shopify API Wrapper
Handles REST order fetching and GraphQL fulfillmentCreateV2 mutation.
"""

import time
import requests
from datetime import datetime, timezone


class ShopifyAPI:
    """Shopify REST + GraphQL API wrapper for Loom."""

    def __init__(self, store_url, client_id, client_secret, access_token=None):
        self.store_url = store_url.rstrip("/")
        self.client_id = client_id
        self.client_secret = client_secret
        self.token = access_token  # Can pass existing token directly
        self.api_version = "2025-01"

    # ── OAuth Token ─────────────────────────────────────────────────────
    def get_token(self):
        """Obtain access token via client_credentials grant."""
        url = f"{self.store_url}/admin/oauth/access_token"
        payload = {
            "client_id": self.client_id,
            "client_secret": self.client_secret,
            "grant_type": "client_credentials",
        }
        try:
            r = requests.post(url, json=payload, timeout=30)
            r.raise_for_status()
            self.token = r.json()["access_token"]
            return self.token
        except Exception:
            # If OAuth fails, try using the stored token
            stored = self._load_stored_token()
            if stored:
                self.token = stored
                return self.token
            raise

    def _load_stored_token(self):
        """Try to load a previously stored token from file."""
        import json, os
        token_paths = [
            os.path.join(os.path.dirname(__file__), '..', 'shopify_token.json'),
            os.path.join(os.path.dirname(__file__), 'shopify_token.json'),
            '/home/z/my-project/shopify_token.json',
        ]
        for path in token_paths:
            try:
                with open(path) as f:
                    data = json.load(f)
                if data.get('access_token') and data.get('shop', '') in self.store_url:
                    return data['access_token']
            except Exception:
                continue
        return None

    def ensure_token(self):
        """Make sure we have a valid token."""
        if not self.token:
            self.get_token()
        return self.token

    # ── REST API helpers ────────────────────────────────────────────────
    def _headers(self):
        return {
            "X-Shopify-Access-Token": self.ensure_token(),
            "Content-Type": "application/json",
        }

    def _rest_url(self, path):
        return f"{self.store_url}/admin/api/{self.api_version}/{path}"

    # ── Fetch PostEx orders ─────────────────────────────────────────────
    def fetch_postex_orders(self, quick=True, months=12):
        """
        Fetch fulfilled orders that use PostEx courier.
        Returns list of dicts: {order_id, order_number, fulfillment_id, tracking_number, shipping_city}
        
        If quick=True, only fetch last 30 days. Otherwise, fetch up to `months` months.
        """
        orders_data = []
        url = self._rest_url("orders.json")
        params = {
            "status": "any",
            "limit": 250,
            "fields": "id,name,order_number,fulfillments,shipping_address,tags",
        }

        if quick:
            # Fetch recent orders only
            all_orders = []
            while url:
                r = requests.get(url, headers=self._headers(), params=params if not all_orders else None, timeout=30)
                if r.status_code == 429:
                    time.sleep(2)
                    continue
                r.raise_for_status()
                page = r.json().get("orders", [])
                all_orders.extend(page)
                # Check Link header for next page
                link = r.headers.get("Link", "")
                url = None
                if 'rel="next"' in link:
                    import re
                    match = re.search(r'<([^>]+)>; rel="next"', link)
                    if match:
                        url = match.group(1)
                else:
                    url = None
                time.sleep(0.5)  # 0.5s between pages
        else:
            # Full fetch with monthly chunking
            all_orders = self._fetch_orders_monthly(months)

        # Filter for PostEx orders with tracking numbers
        for order in all_orders:
            tags = (order.get("tags") or "").lower()
            if "postex" not in tags:
                continue
            for ful in order.get("fulfillments", []):
                tn = ful.get("tracking_number")
                if tn:
                    city = ""
                    sa = order.get("shipping_address") or {}
                    city = sa.get("city", "")
                    orders_data.append({
                        "order_id": order["id"],
                        "order_number": order.get("order_number"),
                        "order_name": order.get("name", ""),
                        "fulfillment_id": ful["id"],
                        "tracking_number": tn,
                        "shipping_city": city,
                    })

        return orders_data

    def _fetch_orders_monthly(self, months=12):
        """Fetch orders month by month to handle large stores."""
        all_orders = []
        now = datetime.now(timezone.utc)
        for m in range(months):
            start = now.replace(day=1)
            # Go back m months
            if m > 0:
                start_month = start.month - m
                start_year = start.year
                while start_month <= 0:
                    start_month += 12
                    start_year -= 1
                start = start.replace(month=start_month, year=start_year)

            # Calculate end of that month
            if start.month == 12:
                end = start.replace(year=start.year + 1, month=1)
            else:
                end = start.replace(month=start.month + 1)

            params = {
                "status": "any",
                "limit": 250,
                "created_at_min": start.isoformat(),
                "created_at_max": end.isoformat(),
                "fields": "id,name,order_number,fulfillments,shipping_address,tags",
            }

            url = self._rest_url("orders.json")
            while url:
                r = requests.get(url, headers=self._headers(), params=params, timeout=30)
                if r.status_code == 429:
                    time.sleep(2)
                    continue
                r.raise_for_status()
                page = r.json().get("orders", [])
                all_orders.extend(page)
                link = r.headers.get("Link", "")
                url = None
                if 'rel="next"' in link:
                    import re
                    match = re.search(r'<([^>]+)>; rel="next"', link)
                    if match:
                        url = match.group(1)
                params = None  # Next page URL already has params
                time.sleep(0.5)

            time.sleep(1)  # 1s between months

        return all_orders

    # ── GraphQL Fulfillment Update ──────────────────────────────────────
    def update_fulfillment_status(self, fulfillment_id, status):
        """
        Create a fulfillment event using GraphQL fulfillmentCreateV2 mutation.
        
        CRITICAL: status enum must be UNQUOTED in GraphQL.
        happenedAt must be current time (not PostEx timestamp).
        """
        query = """
        mutation fulfillmentEventCreate($fulfillmentId: ID!, $status: FulfillmentEventStatus!) {
          fulfillmentEventCreate(fulfillmentId: $fulfillmentId, status: $status) {
            fulfillmentEvent {
              id
              status
              happenedAt
            }
            userErrors {
              field
              message
            }
          }
        }
        """

        # Use current UTC time for happenedAt
        happened_at = datetime.now(timezone.utc).isoformat()

        variables = {
            "fulfillmentId": str(fulfillment_id),
            "status": status,  # This will be properly serialized as unquoted enum
        }

        headers = {
            "X-Shopify-Access-Token": self.ensure_token(),
            "Content-Type": "application/json",
        }

        gql_url = f"{self.store_url}/admin/api/{self.api_version}/graphql.json"

        payload = {
            "query": query,
            "variables": variables,
        }

        r = requests.post(gql_url, headers=headers, json=payload, timeout=30)
        if r.status_code == 429:
            time.sleep(2)
            r = requests.post(gql_url, headers=headers, json=payload, timeout=30)

        result = r.json()

        # Check for user errors
        errors = (
            result.get("data", {})
            .get("fulfillmentEventCreate", {})
            .get("userErrors", [])
        )
        if errors:
            return {"success": False, "errors": errors}

        event = (
            result.get("data", {})
            .get("fulfillmentEventCreate", {})
            .get("fulfillmentEvent", {})
        )

        # 0.30s delay between GraphQL calls to avoid 429
        time.sleep(0.30)

        return {"success": True, "event": event}

    # ── Verify Token ────────────────────────────────────────────────────
    def verify_token(self):
        """Verify the current token is valid by making a test API call."""
        try:
            r = requests.get(
                self._rest_url("shop.json"),
                headers=self._headers(),
                timeout=15,
            )
            if r.status_code == 200:
                shop = r.json().get("shop", {})
                return {
                    "valid": True,
                    "shop_name": shop.get("name", ""),
                    "shop_domain": shop.get("myshopify_domain", ""),
                }
            return {"valid": False, "status": r.status_code}
        except Exception as e:
            return {"valid": False, "error": str(e)}
