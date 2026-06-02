"""
Loom – 6-Priority Rule Engine v9.0
Maps PostEx tracking statuses to Shopify fulfillment event statuses.

Priority order:
  1. Return History Check
  2. Return Status Check
  3. Delivered Check
  4. Specific Action Status Override (Attempted / OFD with age)
  5. Delayed Check (Sindh 3d / Others 5d)
  6. Default Status Map
"""

from datetime import datetime, timezone

# ── Sindh cities for delayed threshold ──────────────────────────────────────
SINDH_CITIES = [
    "karachi", "hyderabad", "badin", "dadu", "jamshoro", "matiati", "sujawal",
    "tando allahyar", "tando muhammad khan", "sukkur", "ghotki", "khairpur",
    "larkana", "jacobabad", "kashmore", "qambar shahdadkot", "shikarpur",
    "mirpur khas", "tharparkar", "umerkot", "shaheed benazirabad",
    "naushahro feroze", "sanghar", "kotri", "sehwan", "hala", "rohri",
    "mirpur mathelo", "daharki", "kamoke", "ratodero", "kandhkot",
    "shahdadkot", "khipro"
]

# ── Return phrases for Priority 1 ──────────────────────────────────────────
RETURN_PHRASES = [
    "returned at merchant warehouse",
    "en route to merchant warehouse",
    "en-route to merchant warehouse",
    "waiting for return",
    "return to any city",
    "return process initiated",
    "en route to lahore warehouse",
    "en-route to lahore warehouse",
    "en route to karachi warehouse",
    "en-route to karachi warehouse",
]

# ── Return statuses for Priority 2 ─────────────────────────────────────────
RETURN_STATUSES = {
    "returned", "out for return", "expired", "return requested",
    "customer requested", "en-route to lahore warehouse",
    "en-route to merchant warehouse",
}

# ── Default status map for Priority 6 ──────────────────────────────────────
STATUS_MAP = {
    "unbooked": "LABEL_PURCHASED",
    "booked": "LABEL_PRINTED",
    "postex warehouse": "CONFIRMED",
    "at mettwear warehouse": "CONFIRMED",
    "picked by postex": "IN_TRANSIT",
    "en-route to postex warehouse": "IN_TRANSIT",
    "out for delivery": "OUT_FOR_DELIVERY",
    "delivered": "DELIVERED",
    "attempted": "ATTEMPTED_DELIVERY",
    "returned": "FAILURE",
    "out for return": "FAILURE",
    "expired": "FAILURE",
    "delivery under review": "IN_TRANSIT",
    "un-assigned by me": "LABEL_PRINTED",
    "auth": "LABEL_PURCHASED",
    "void": "FAILURE",
    "account auth": "LABEL_PURCHASED",
    "account void": "FAILURE",
    "customer requested": "FAILURE",
    "return requested": "FAILURE",
    "en-route to lahore warehouse": "FAILURE",
    "en-route to merchant warehouse": "FAILURE",
}

DEFAULT_STATUS = "IN_TRANSIT"


def _lower(s):
    """Safely lowercase a string."""
    return (s or "").strip().lower()


def _days_since(dt_str):
    """Return days elapsed since an ISO datetime string (UTC)."""
    if not dt_str:
        return 999
    try:
        dt = datetime.fromisoformat(dt_str.replace("Z", "+00:00"))
        now = datetime.now(timezone.utc)
        return (now - dt).total_seconds() / 86400
    except Exception:
        return 999


def _get_city_region(city):
    """Return 'Sindh' if city is in SINDH_CITIES, else 'Other'."""
    if _lower(city) in SINDH_CITIES:
        return "Sindh"
    return "Other"


def _find_latest_ofd_age(history):
    """
    Find the latest 'out for delivery' entry in history and return
    the age in days since its updatedAt.
    """
    if not history:
        return None
    for entry in sorted(history, key=lambda h: h.get("updatedAt", ""), reverse=True):
        activity = _lower(entry.get("activity", "") or entry.get("status", ""))
        if "out for delivery" in activity:
            updated = entry.get("updatedAt", "")
            return _days_since(updated)
    return None


def _check_return_history(history):
    """Priority 1: Check if any history message contains return phrases."""
    if not history:
        return None
    for entry in history:
        activity = _lower(entry.get("activity", "") or entry.get("status", ""))
        # Also check merchant warehouse pattern: 'en route to' + 'warehouse' but NOT 'postex'
        for phrase in RETURN_PHRASES:
            if phrase in activity:
                return phrase
        # Merchant city warehouse pattern
        if "en route to" in activity and "warehouse" in activity and "postex" not in activity:
            return activity
    return None


def _check_delayed(history, shipping_city=None):
    """Priority 5: Check if shipment is delayed based on warehouse departure."""
    if not history:
        return None
    for entry in history:
        activity = _lower(entry.get("activity", "") or entry.get("status", ""))
        if "departed to postex" in activity and "warehouse" in activity:
            updated = entry.get("updatedAt", "")
            days = _days_since(updated)
            region = _get_city_region(shipping_city or "")
            threshold = 3 if region == "Sindh" else 5
            if days >= threshold:
                return {
                    "days": round(days, 1),
                    "region": region,
                    "threshold": threshold,
                    "trigger": activity,
                }
    return None


def evaluate(postex_status, history=None, shipping_city=None):
    """
    Run the 6-priority rule engine on a PostEx tracking result.

    Parameters
    ----------
    postex_status : str
        The current PostEx status string.
    history : list[dict]
        List of PostEx history entries (each with 'activity'/'status' and 'updatedAt').
    shipping_city : str
        Shipping destination city (for Sindh/Other delayed threshold).

    Returns
    -------
    dict with keys: status, message, rule, priority
    """
    status_lower = _lower(postex_status)
    history = history or []

    # ── Priority 1: Return History Check ────────────────────────────────
    return_phrase = _check_return_history(history)
    if return_phrase:
        return {
            "status": "FAILURE",
            "message": f"FAILED: {return_phrase}",
            "rule": "Return History Check",
            "priority": 1,
        }

    # ── Priority 2: Return Status Check ─────────────────────────────────
    if status_lower in RETURN_STATUSES:
        return {
            "status": "FAILURE",
            "message": f"FAILED: {postex_status}",
            "rule": "Return Status Check",
            "priority": 2,
        }

    # ── Priority 3: Delivered Check ─────────────────────────────────────
    if status_lower == "delivered":
        return {
            "status": "DELIVERED",
            "message": "PostEx: Delivered",
            "rule": "Delivered Check",
            "priority": 3,
        }

    # ── Priority 4: Specific Action Status Override ─────────────────────
    if status_lower == "attempted":
        return {
            "status": "ATTEMPTED_DELIVERY",
            "message": "PostEx: Attempted delivery",
            "rule": "Action Status Override",
            "priority": 4,
        }

    if status_lower == "out for delivery":
        ofd_age = _find_latest_ofd_age(history)
        if ofd_age is not None and ofd_age >= 3:
            return {
                "status": "ATTEMPTED_DELIVERY",
                "message": f"ATTEMPTED: Out For Delivery {round(ofd_age, 1)}d (likely failed)",
                "rule": "Action Status Override (OFD aged)",
                "priority": 4,
            }
        return {
            "status": "OUT_FOR_DELIVERY",
            "message": "PostEx: Out For Delivery",
            "rule": "Action Status Override",
            "priority": 4,
        }

    # ── Priority 5: Delayed Check ───────────────────────────────────────
    delayed = _check_delayed(history, shipping_city)
    if delayed:
        return {
            "status": "DELAYED",
            "message": (
                f"DELAYED: {delayed['trigger']} "
                f"({delayed['days']}d ago, {delayed['region']} {delayed['threshold']}d limit)"
            ),
            "rule": "Delayed Check",
            "priority": 5,
        }

    # ── Priority 6: Default Status Map ──────────────────────────────────
    mapped = STATUS_MAP.get(status_lower, DEFAULT_STATUS)
    return {
        "status": mapped,
        "message": f"PostEx: {postex_status} → {mapped}",
        "rule": "Default Status Map",
        "priority": 6,
    }
