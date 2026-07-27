"""SQLite-backed MemoryStore fixture matching the API used by the bridge.

This is not an implementation submitted to the benchmark and is never included in
the cross-adapter matrix. It exists solely to keep the wire-bridge smoke deterministic
without a mutable /tmp checkout.
"""

import re
import sqlite3


class MemoryStore:
    def __init__(self, path):
        self.path = path
        self.conn = None

    def __enter__(self):
        self.conn = sqlite3.connect(self.path)
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS entities (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              name TEXT NOT NULL UNIQUE,
              entity_type TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS observations (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              entity_id INTEGER NOT NULL,
              text TEXT NOT NULL,
              scope TEXT,
              created_at TEXT DEFAULT CURRENT_TIMESTAMP
            );
            """
        )
        return self

    def __exit__(self, exc_type, exc, traceback):
        if exc_type is None:
            self.conn.commit()
        self.conn.close()
        self.conn = None

    def resolve_entity(self, name, entity_type):
        self.conn.execute(
            "INSERT OR IGNORE INTO entities(name, entity_type) VALUES (?, ?)",
            (name, entity_type),
        )
        row = self.conn.execute("SELECT id FROM entities WHERE name = ?", (name,)).fetchone()
        return row["id"]

    def add_observation(self, entity_id, text, scope=None):
        cur = self.conn.execute(
            "INSERT INTO observations(entity_id, text, scope) VALUES (?, ?, ?)",
            (entity_id, text, scope),
        )
        return cur.lastrowid

    def search(self, question, limit=8):
        tokens = set(re.findall(r"[a-z0-9]+", question.lower()))
        rows = self.conn.execute(
            """
            SELECT e.id, e.name, e.entity_type, group_concat(o.text, ' ') AS body
            FROM entities e JOIN observations o ON o.entity_id = e.id
            GROUP BY e.id ORDER BY e.id
            """
        ).fetchall()
        ranked = []
        for row in rows:
            body_tokens = set(re.findall(r"[a-z0-9]+", (row["body"] or "").lower()))
            score = len(tokens & body_tokens)
            if score:
                ranked.append((score, dict(row)))
        ranked.sort(key=lambda item: (-item[0], item[1]["id"]))
        return [row for _, row in ranked[:limit]]

    def get_observations(self, entity_id):
        rows = self.conn.execute(
            "SELECT id, text, scope, created_at FROM observations WHERE entity_id = ? ORDER BY id",
            (entity_id,),
        ).fetchall()
        return [dict(row) for row in rows]
