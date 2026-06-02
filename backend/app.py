"""
Loom – Flask Backend
Shopify Embedded App for PostEx delivery status sync.
100% Free deployment: PythonAnywhere + SQLite + cron-job.org
"""

import os
import json
from datetime import datetime, timezone
from flask import Flask, request, jsonify
from flask_cors import CORS
from dotenv import load_dotenv

# Load .env file FIRST
load_dotenv()

from shopify_api import ShopifyAPI
from postex_api import PostExAPI
from rule_engine import evaluate
from database import Database

# ── App Setup ───────────────────────────────────────────────────────────
app = Flask(__name__)
CORS(app, origins=[
    "https://*.vercel.app",
    "https://*.netlify.app",
    "https://*.myshopify.com",
    "http://localhost:3000",
])

# ── Config from Environment ─────────────────────────────────────────────
SHOPIFY_CLIENT_ID = os.environ.get("SHOPIFY_CLIENT_ID", "")
SHOPIFY_CLIENT_SECRET = os.environ.get("SHOPIFY_CLIENT_SECRET", "")
SHOPIFY_STORE_URL = os.environ.get("SHOPIFY_STORE_URL", "")
SHOPIFY_ACCESS_TOKEN = os.environ.get("SHOPIFY_ACCESS_TOKEN", "")
POSTEX_TOKEN = os.environ.get("POSTEX_TOKEN", "")
APP_URL = os.environ.get("APP_URL", "")
DATABASE_PATH = os.environ.get("DATABASE_PATH", "")

# ── Initialize Services ─────────────────────────────────────────────────
db = Database(DATABASE_PATH if DATABASE_PATH else None)


def get_shopify():
    return ShopifyAPI(SHOPIFY_STORE_URL, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET, SHOPIFY_ACCESS_TOKEN)


def get_postex():
    return PostExAPI(POSTEX_TOKEN)


# ═══════════════════════════════════════════════════════════════════════
# ENDPOINTS
# ═══════════════════════════════════════════════════════════════════════


@app.route("/api/health", methods=["GET"])
def health():
    """Health check endpoint – used by cron-job.org and uptime monitors."""
    return jsonify({
        "status": "ok",
        "app": "Loom",
        "time": datetime.now(timezone.utc).isoformat(),
    })


@app.route("/api/token", methods=["GET"])
def verify_token():
    """Verify Shopify API token is valid."""
    try:
        shopify = get_shopify()
        result = shopify.verify_token()
        return jsonify(result)
    except Exception as e:
        return jsonify({"valid": False, "error": str(e)}), 500


@app.route("/api/auth/shopify", methods=["GET"])
def auth_shopify():
    """Shopify OAuth installer endpoint."""
    shop = request.args.get("shop")
    if not shop:
        return jsonify({"error": "Missing shop parameter"}), 400
    return jsonify({
        "message": "Loom app authentication",
        "shop": shop,
        "app_url": APP_URL,
        "instructions": "Install this app from your Shopify Partners dashboard",
    })


@app.route("/api/sync", methods=["POST", "GET"])
def sync():
    """
    Trigger a sync between PostEx tracking statuses and Shopify fulfillment events.
    
    Body (optional):
    {
      "quick": true,        // Only last 30 days (default: true)
      "months": 12,         // How many months back for full sync
      "dry_run": false      // If true, don't update Shopify, just return results
    }
    """
    body = request.get_json(silent=True) or {}
    quick = body.get("quick", True)
    months = body.get("months", 12)
    dry_run = body.get("dry_run", False)

    # Create sync log
    sync_type = "quick" if quick else "full"
    log_id = db.create_sync_log(sync_type=sync_type)

    try:
        # Step 1: Get Shopify token
        shopify = get_shopify()
        shopify.ensure_token()

        # Step 2: Fetch PostEx orders from Shopify
        orders = shopify.fetch_postex_orders(quick=quick, months=months)
        
        if not orders:
            db.update_sync_log(log_id, "completed", "No PostEx orders found", 0, 0, 0)
            return jsonify({
                "status": "completed",
                "message": "No PostEx orders found",
                "log_id": log_id,
                "orders_processed": 0,
                "orders_updated": 0,
                "orders_failed": 0,
            })

        # Step 3: Batch track via PostEx
        tracking_numbers = [o["tracking_number"] for o in orders]
        postex = get_postex()
        tracking_results = postex.track_bulk(tracking_numbers)

        # Build lookup dict
        tracking_map = {r["tracking_number"]: r for r in tracking_results}

        # Step 4: Run rule engine and update Shopify
        processed = 0
        updated = 0
        failed = 0
        results = []

        for order in orders:
            tn = order["tracking_number"]
            track_data = tracking_map.get(tn, {
                "tracking_number": tn,
                "status": "UNKNOWN",
                "history": [],
                "error": "Not found in PostEx response",
            })

            # Run 6-priority rule engine
            rule_result = evaluate(
                postex_status=track_data["status"],
                history=track_data.get("history", []),
                shipping_city=order.get("shipping_city", ""),
            )

            processed += 1

            # Log to database
            db.add_report_entry(
                sync_log_id=log_id,
                order_number=str(order.get("order_number", "")),
                order_name=order.get("order_name", ""),
                tracking_number=tn,
                postex_status=track_data["status"],
                shopify_status=rule_result["status"],
                message=rule_result["message"],
                rule=rule_result["rule"],
                priority=rule_result["priority"],
                shipping_city=order.get("shipping_city", ""),
            )

            # Update Shopify fulfillment event (unless dry_run)
            if not dry_run and not track_data.get("error"):
                try:
                    update_result = shopify.update_fulfillment_status(
                        fulfillment_id=order["fulfillment_id"],
                        status=rule_result["status"],
                    )
                    if update_result.get("success"):
                        updated += 1
                    else:
                        failed += 1
                except Exception as e:
                    failed += 1
                    db.add_report_entry(
                        sync_log_id=log_id,
                        order_number=str(order.get("order_number", "")),
                        order_name=order.get("order_name", ""),
                        tracking_number=tn,
                        postex_status=track_data["status"],
                        shopify_status="ERROR",
                        message=f"Shopify update failed: {str(e)}",
                        rule="API Error",
                        priority=0,
                        shipping_city=order.get("shipping_city", ""),
                    )
            elif dry_run:
                updated += 1  # Would have updated

            results.append({
                "order_number": order.get("order_number"),
                "tracking_number": tn,
                "postex_status": track_data["status"],
                "shopify_status": rule_result["status"],
                "message": rule_result["message"],
                "rule": rule_result["rule"],
            })

        # Update sync log
        db.update_sync_log(
            log_id,
            "completed",
            f"Sync completed. {processed} orders, {updated} updated, {failed} failed.",
            processed,
            updated,
            failed,
        )

        return jsonify({
            "status": "completed",
            "log_id": log_id,
            "orders_processed": processed,
            "orders_updated": updated,
            "orders_failed": failed,
            "dry_run": dry_run,
            "results": results[:50],
        })

    except Exception as e:
        db.update_sync_log(log_id, "failed", str(e), 0, 0, 0)
        return jsonify({
            "status": "failed",
            "log_id": log_id,
            "error": str(e),
        }), 500


@app.route("/api/track/<tracking_number>", methods=["GET"])
def track(tracking_number):
    """Get PostEx tracking status for a single tracking number."""
    try:
        postex = get_postex()
        result = postex.track_single(tracking_number)

        # Also run rule engine
        rule_result = evaluate(
            postex_status=result["status"],
            history=result.get("history", []),
        )

        return jsonify({
            "tracking_number": tracking_number,
            "postex_status": result["status"],
            "shopify_status": rule_result["status"],
            "message": rule_result["message"],
            "rule": rule_result["rule"],
            "priority": rule_result["priority"],
            "history": result.get("history", []),
            "error": result.get("error"),
        })
    except Exception as e:
        return jsonify({
            "tracking_number": tracking_number,
            "error": str(e),
        }), 500


@app.route("/api/fail", methods=["POST"])
def manual_fail():
    """
    Manual status override – mark an order as FAILED.
    
    Body:
    {
      "order_number": "1077",
      "tracking_number": "27218850025631",
      "reason": "Customer refused delivery"
    }
    """
    body = request.get_json(silent=True) or {}
    order_number = body.get("order_number")
    tracking_number = body.get("tracking_number")
    reason = body.get("reason", "Manual override")

    if not order_number and not tracking_number:
        return jsonify({"error": "Provide order_number or tracking_number"}), 400

    try:
        shopify = get_shopify()
        shopify.ensure_token()

        # Find the fulfillment
        if not tracking_number and order_number:
            orders = shopify.fetch_postex_orders(quick=True)
            for o in orders:
                if str(o.get("order_number")) == str(order_number):
                    tracking_number = o["tracking_number"]
                    fulfillment_id = o["fulfillment_id"]
                    break
            else:
                return jsonify({"error": f"Order #{order_number} not found"}), 404
        else:
            orders = shopify.fetch_postex_orders(quick=True)
            fulfillment_id = None
            for o in orders:
                if o["tracking_number"] == tracking_number:
                    fulfillment_id = o["fulfillment_id"]
                    order_number = o.get("order_number")
                    break
            if not fulfillment_id:
                return jsonify({"error": f"Tracking {tracking_number} not found"}), 404

        # Update Shopify with FAILURE status
        result = shopify.update_fulfillment_status(
            fulfillment_id=fulfillment_id,
            status="FAILURE",
        )

        # Log to database
        log_id = db.create_sync_log(sync_type="manual")
        db.add_report_entry(
            sync_log_id=log_id,
            order_number=str(order_number),
            tracking_number=tracking_number,
            postex_status="OVERRIDE",
            shopify_status="FAILURE",
            message=f"Manual override: {reason}",
            rule="Manual Override",
            priority=0,
        )
        db.update_sync_log(log_id, "completed", f"Manual fail: {reason}", 1, 1, 0)

        return jsonify({
            "status": "completed",
            "order_number": order_number,
            "tracking_number": tracking_number,
            "shopify_status": "FAILURE",
            "reason": reason,
            "shopify_result": result,
        })

    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/logs", methods=["GET"])
def get_logs():
    """Get recent sync logs."""
    limit = request.args.get("limit", 50, type=int)
    logs = db.get_sync_logs(limit=limit)
    return jsonify({"logs": logs})


@app.route("/api/report", methods=["GET"])
def get_report():
    """Get sync report entries."""
    sync_log_id = request.args.get("sync_log_id", type=int)
    tracking_number = request.args.get("tracking_number")
    limit = request.args.get("limit", 100, type=int)
    
    report = db.get_report(
        sync_log_id=sync_log_id,
        tracking_number=tracking_number,
        limit=limit,
    )
    return jsonify({"report": report})


@app.route("/api/dashboard", methods=["GET"])
def dashboard():
    """Get dashboard summary data."""
    summary = db.get_latest_report_summary()
    recent_logs = db.get_sync_logs(limit=10)
    return jsonify({
        "latest_sync": summary,
        "recent_logs": recent_logs,
    })


# ── Main ────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=True)
