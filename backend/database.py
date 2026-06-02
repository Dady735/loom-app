"""
Loom – Database Helper with Turso + Local SQLite Support
Manages sync_logs and sync_report tables.

Production: Turso (libSQL) – free, persistent, no credit card
Local dev:  SQLite – file-based, no setup
"""

import os
import sqlite3
from datetime import datetime, timezone

# Turso support via libsql-experimental
TURSO_URL = os.environ.get("TURSO_DATABASE_URL", "")
TURSO_AUTH_TOKEN = os.environ.get("TURSO_AUTH_TOKEN", "")
USE_TURSO = bool(TURSO_URL and TURSO_URL.startswith("libsql://") and TURSO_AUTH_TOKEN)

# Column names for each table (used to convert tuples → dicts for Turso)
SYNC_LOGS_COLUMNS = [
    "id", "timestamp", "status", "details",
    "orders_processed", "orders_updated", "orders_failed", "sync_type",
]
SYNC_REPORT_COLUMNS = [
    "id", "sync_log_id", "order_number", "order_name", "tracking_number",
    "postex_status", "shopify_status", "message", "rule", "priority",
    "shipping_city", "updated_at",
]


def _get_turso_conn():
    """Get a Turso/libSQL connection."""
    try:
        from libsql_experimental import connect
        conn = connect(TURSO_URL, auth_token=TURSO_AUTH_TOKEN)
        # libsql_experimental doesn't support row_factory
        return conn
    except ImportError:
        raise RuntimeError(
            "libsql-experimental not installed. Run: pip install libsql-experimental"
        )


def _get_sqlite_conn(db_path):
    """Get a local SQLite connection."""
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    return conn


def _rows_to_dicts(rows, columns):
    """Convert list of tuples to list of dicts (for Turso results)."""
    return [dict(zip(columns, row)) for row in rows]


def _row_to_dict(row, columns):
    """Convert a single tuple to dict (for Turso result)."""
    if row is None:
        return None
    return dict(zip(columns, row))


class Database:
    """Database manager for Loom – supports Turso (prod) and SQLite (dev)."""

    def __init__(self, db_path="sync_data.db"):
        self.db_path = db_path
        self._init_db()

    def _get_conn(self):
        if USE_TURSO:
            return _get_turso_conn()
        return _get_sqlite_conn(self.db_path)

    def _init_db(self):
        """Create tables if they don't exist."""
        conn = self._get_conn()
        c = conn.cursor()

        c.execute("""
            CREATE TABLE IF NOT EXISTS sync_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                details TEXT,
                orders_processed INTEGER DEFAULT 0,
                orders_updated INTEGER DEFAULT 0,
                orders_failed INTEGER DEFAULT 0,
                sync_type TEXT DEFAULT 'quick'
            )
        """)

        c.execute("""
            CREATE TABLE IF NOT EXISTS sync_report (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                sync_log_id INTEGER,
                order_number TEXT,
                order_name TEXT,
                tracking_number TEXT,
                postex_status TEXT,
                shopify_status TEXT,
                message TEXT,
                rule TEXT,
                priority INTEGER,
                shipping_city TEXT,
                updated_at TEXT,
                FOREIGN KEY (sync_log_id) REFERENCES sync_logs(id)
            )
        """)

        # Create indexes for fast lookups
        c.execute("CREATE INDEX IF NOT EXISTS idx_report_tracking ON sync_report(tracking_number)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_report_order ON sync_report(order_number)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON sync_logs(timestamp)")

        conn.commit()
        conn.close()

    # ── Sync Logs ───────────────────────────────────────────────────────

    def create_sync_log(self, sync_type="quick"):
        """Create a new sync log entry and return its ID."""
        conn = self._get_conn()
        c = conn.cursor()
        now = datetime.now(timezone.utc).isoformat()
        c.execute(
            "INSERT INTO sync_logs (timestamp, status, details, sync_type) VALUES (?, ?, ?, ?)",
            (now, "running", "Sync started", sync_type),
        )
        log_id = c.lastrowid
        conn.commit()
        conn.close()
        return log_id

    def update_sync_log(self, log_id, status, details=None, processed=0, updated=0, failed=0):
        """Update a sync log entry."""
        conn = self._get_conn()
        c = conn.cursor()
        c.execute(
            """UPDATE sync_logs 
               SET status=?, details=?, orders_processed=?, orders_updated=?, orders_failed=?
               WHERE id=?""",
            (status, details, processed, updated, failed, log_id),
        )
        conn.commit()
        conn.close()

    def get_sync_logs(self, limit=50):
        """Get recent sync logs."""
        conn = self._get_conn()
        c = conn.cursor()
        c.execute(
            "SELECT * FROM sync_logs ORDER BY id DESC LIMIT ?",
            (limit,),
        )
        if USE_TURSO:
            rows = _rows_to_dicts(c.fetchall(), SYNC_LOGS_COLUMNS)
        else:
            rows = [dict(r) for r in c.fetchall()]
        conn.close()
        return rows

    # ── Sync Report ─────────────────────────────────────────────────────

    def add_report_entry(self, sync_log_id, order_number, order_name, tracking_number,
                         postex_status, shopify_status, message, rule, priority,
                         shipping_city=""):
        """Add a single report entry."""
        conn = self._get_conn()
        c = conn.cursor()
        now = datetime.now(timezone.utc).isoformat()
        c.execute(
            """INSERT INTO sync_report 
               (sync_log_id, order_number, order_name, tracking_number,
                postex_status, shopify_status, message, rule, priority,
                shipping_city, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (sync_log_id, order_number, order_name, tracking_number,
             postex_status, shopify_status, message, rule, priority,
             shipping_city, now),
        )
        conn.commit()
        conn.close()

    def get_report(self, sync_log_id=None, tracking_number=None, limit=100):
        """Get report entries, optionally filtered."""
        conn = self._get_conn()
        c = conn.cursor()
        
        if sync_log_id:
            c.execute(
                "SELECT * FROM sync_report WHERE sync_log_id=? ORDER BY id DESC LIMIT ?",
                (sync_log_id, limit),
            )
        elif tracking_number:
            c.execute(
                "SELECT * FROM sync_report WHERE tracking_number=? ORDER BY id DESC LIMIT ?",
                (tracking_number, limit),
            )
        else:
            c.execute(
                "SELECT * FROM sync_report ORDER BY id DESC LIMIT ?",
                (limit,),
            )
        
        if USE_TURSO:
            rows = _rows_to_dicts(c.fetchall(), SYNC_REPORT_COLUMNS)
        else:
            rows = [dict(r) for r in c.fetchall()]
        conn.close()
        return rows

    def get_latest_report_summary(self):
        """Get a summary of the latest sync."""
        conn = self._get_conn()
        c = conn.cursor()
        c.execute("SELECT * FROM sync_logs ORDER BY id DESC LIMIT 1")
        
        if USE_TURSO:
            row = c.fetchone()
            if not row:
                conn.close()
                return None
            log_dict = _row_to_dict(row, SYNC_LOGS_COLUMNS)
        else:
            log = c.fetchone()
            if not log:
                conn.close()
                return None
            log_dict = dict(log)

        c.execute(
            """SELECT shopify_status, COUNT(*) as count 
               FROM sync_report 
               WHERE sync_log_id=? 
               GROUP BY shopify_status""",
            (log_dict["id"],),
        )
        
        if USE_TURSO:
            status_counts = {r[0]: r[1] for r in c.fetchall()}
        else:
            status_counts = {r["shopify_status"]: r["count"] for r in c.fetchall()}
        conn.close()
        
        log_dict["status_counts"] = status_counts
        return log_dict
