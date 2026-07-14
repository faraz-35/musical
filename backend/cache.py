import json
import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).parent / "musical.db"

# Bump when the cached record shape changes incompatibly. On init, any cache
# written under an older schema is wiped so the extension never renders stale
# fields (e.g. the removed `translation_romantic`) alongside the new ones.
CACHE_VERSION = 2


def _conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init():
    with _conn() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS subtitles (
                video_id   TEXT PRIMARY KEY,
                title      TEXT,
                artist     TEXT,
                lang       TEXT,
                source     TEXT,
                data_json  TEXT NOT NULL,
                created_at TEXT DEFAULT (datetime('now'))
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS meta (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )
            """
        )
        row = conn.execute(
            "SELECT value FROM meta WHERE key = 'cache_version'"
        ).fetchone()
        if not row or int(row["value"]) < CACHE_VERSION:
            conn.execute("DELETE FROM subtitles")
            conn.execute(
                "INSERT INTO meta(key, value) VALUES('cache_version', ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (str(CACHE_VERSION),),
            )


def get(video_id):
    with _conn() as conn:
        row = conn.execute(
            "SELECT * FROM subtitles WHERE video_id = ?", (video_id,)
        ).fetchone()
    if not row:
        return None
    rec = dict(row)
    rec["videoId"] = rec.pop("video_id")
    rec["lines"] = json.loads(rec.pop("data_json"))
    return rec


def put(record):
    with _conn() as conn:
        conn.execute(
            """
            INSERT INTO subtitles (video_id, title, artist, lang, source, data_json)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(video_id) DO UPDATE SET
                title     = excluded.title,
                artist    = excluded.artist,
                lang      = excluded.lang,
                source    = excluded.source,
                data_json = excluded.data_json
            """,
            (
                record["videoId"],
                record.get("title"),
                record.get("artist"),
                record.get("lang"),
                record.get("source"),
                json.dumps(record["lines"], ensure_ascii=False),
            ),
        )
