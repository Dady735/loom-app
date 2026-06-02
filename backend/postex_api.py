"""
Loom – PostEx API Wrapper
Handles bulk tracking lookups against the PostEx courier service.

IMPORTANT: PostEx bulk tracking uses GET method with 'TrackingNumbers' query param.
Auth header key is 'token', NOT 'Authorization: Bearer'.
"""

import requests


class PostExAPI:
    """PostEx courier tracking API wrapper for Loom."""

    def __init__(self, token):
        """
        Parameters
        ----------
        token : str
            PostEx API token (the base64-encoded string).
            Sent as 'token' header, NOT as 'Authorization: Bearer'.
        """
        self.token = token
        self.base_url = "https://api.postex.pk/services/integration/api/order/v1"
        self.batch_size = 50

    def _headers(self):
        """PostEx auth uses 'token' header key, not Bearer."""
        return {
            "token": self.token,
        }

    def track_single(self, tracking_number):
        """Track a single order by tracking number using the bulk endpoint."""
        results = self.track_bulk([tracking_number])
        return results[0] if results else {
            "tracking_number": tracking_number,
            "status": "UNKNOWN",
            "history": [],
            "raw": None,
            "error": "No response",
        }

    def track_bulk(self, tracking_numbers):
        """
        Track multiple orders in bulk (max 50 per request).

        PostEx bulk tracking uses GET method with 'TrackingNumbers' query parameter.
        Multiple tracking numbers are passed as repeated query params.

        Parameters
        ----------
        tracking_numbers : list[str]
            List of tracking number strings.

        Returns
        -------
        list[dict] - one result per tracking number
        """
        results = []

        # Process in batches of 50
        for i in range(0, len(tracking_numbers), self.batch_size):
            batch = tracking_numbers[i : i + self.batch_size]

            try:
                # PostEx uses GET with TrackingNumbers query param
                # Multiple values passed as repeated params
                url = f"{self.base_url}/track-bulk-order"
                params = [("TrackingNumbers", str(tn)) for tn in batch]

                r = requests.get(url, headers=self._headers(), params=params, timeout=60)
                r.raise_for_status()
                data = r.json()

                # Parse bulk response - data is in "dist" array
                dist = data.get("dist", [])
                if isinstance(dist, list):
                    for item in dist:
                        tn = ""
                        tr = item.get("trackingResponse")
                        if tr and isinstance(tr, dict):
                            tn = tr.get("trackingNumber", "")
                        results.append(self._parse_single_item(item, tn))
                else:
                    # Fallback: track individually
                    for tn in batch:
                        results.append(self._track_one_fallback(tn))

            except Exception as e:
                # If bulk fails, try individually for this batch
                for tn in batch:
                    try:
                        results.append(self._track_one_fallback(tn))
                    except Exception as e2:
                        results.append({
                            "tracking_number": tn,
                            "status": "ERROR",
                            "history": [],
                            "raw": None,
                            "error": str(e2),
                        })

        return results

    def _track_one_fallback(self, tracking_number):
        """Fallback: track a single number using the bulk endpoint with one item."""
        url = f"{self.base_url}/track-bulk-order"
        params = [("TrackingNumbers", str(tracking_number))]
        r = requests.get(url, headers=self._headers(), params=params, timeout=30)
        r.raise_for_status()
        data = r.json()
        dist = data.get("dist", [])
        if dist:
            return self._parse_single_item(dist[0], tracking_number)
        return {
            "tracking_number": tracking_number,
            "status": "UNKNOWN",
            "history": [],
            "raw": data,
            "error": "Not found in PostEx",
        }

    def _parse_single_item(self, item, fallback_tn):
        """Parse a single tracking result from the PostEx 'dist' array."""
        tracking_response = item.get("trackingResponse")

        # trackingResponse can be null – always check
        if not tracking_response or not isinstance(tracking_response, dict):
            return {
                "tracking_number": fallback_tn,
                "status": "UNKNOWN",
                "history": [],
                "raw": item,
                "error": "No tracking response",
            }

        tracking = tracking_response.get("trackingNumber", fallback_tn)

        # PostEx uses 'transactionStatus' as the current status field
        current_status = (
            tracking_response.get("transactionStatus", "")
            or tracking_response.get("status", "")
            or "UNKNOWN"
        )

        # History might be in 'orderStatusHistory' or 'history'
        history = tracking_response.get("orderStatusHistory", [])
        if not isinstance(history, list):
            history = tracking_response.get("history", [])
            if not isinstance(history, list):
                history = []

        return {
            "tracking_number": tracking,
            "status": current_status,
            "history": history,
            "raw": item,
            "error": None,
        }
