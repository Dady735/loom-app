"""
Loom – SQLite Database Helper
Manages sync_logs and sync_report tables.
Pure SQLite – no external DB service needed, no credit card.
"""

import os
import sqlite3
from datetime import datetime, timezone


class Database:
    """Database manager for Loom – pure SQLite, file-based."""

    def __init__(self, db_path=None):
        if db_path is None:
            # Default: store next to this file
            db_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "loom.db")
        self.db_path = db_path
        self._init_db()

    def _get_conn(self):
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn

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

        # Indexes
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
        
        rows = [dict(r) for r in c.fetchall()]
        conn.close()
        return rows

    def get_latest_report_summary(self):
        """Get a summary of the latest sync."""
        conn = self._get_conn()
        c = conn.cursor()
        c.execute("SELECT * FROM sync_logs ORDER BY id DESC LIMIT 1")
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
        status_counts = {r["shopify_status"]: r["count"] for r in c.fetchall()}
        conn.close()
        
        log_dict["status_counts"] = status_counts
        return log_dict
