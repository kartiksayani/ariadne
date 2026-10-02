#!/usr/bin/env python3
"""Local POC mailbox. SQLite is a test fixture, not Ariadne's production store."""
import argparse
import json
import os
from pathlib import Path
import sqlite3
import sys
import time
import uuid


def connect(project):
    directory = Path(project).resolve() / ".ariadne-mods-poc"
    directory.mkdir(mode=0o700, exist_ok=True)
    os.chmod(directory, 0o700)
    db = sqlite3.connect(directory / "queue.sqlite3", timeout=3)
    db.row_factory = sqlite3.Row
    db.executescript("""
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, generation TEXT NOT NULL, paused INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS inputs (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
        session TEXT NOT NULL, item TEXT NOT NULL, text TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'queued', generation TEXT, turn TEXT, answer TEXT);
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, at REAL, session TEXT, kind TEXT, data TEXT);
    """)
    return db


def event(db, session, kind, data):
    db.execute("INSERT INTO events(at,session,kind,data) VALUES(?,?,?,?)",
               (time.time(), session, kind, json.dumps(data)))


def operate(db, action, request):
    sid = str(request.get("session", ""))
    if not sid or len(sid) > 128:
        raise ValueError("A session ID is required")
    db.execute("BEGIN IMMEDIATE")
    try:
        row = db.execute("SELECT * FROM sessions WHERE id=?", (sid,)).fetchone()
        if action == "connect":
            generation = str(uuid.uuid4())
            uncertain = db.execute("SELECT 1 FROM inputs WHERE session=? AND state IN ('claimed','running','failed')", (sid,)).fetchone()
            db.execute("INSERT INTO sessions VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET generation=excluded.generation, paused=excluded.paused",
                       (sid, generation, int(bool(uncertain))))
            event(db, sid, "connected", {"generation": generation, "paused": bool(uncertain)})
            result = {"session": sid, "generation": generation, "paused": bool(uncertain)}
        elif action == "enqueue":
            if not row:
                raise ValueError("Connect this session with /ariadne-connect first")
            text = request.get("text")
            item = request.get("item", "finding-1")
            if not isinstance(text, str) or not 1 <= len(text) <= 8000:
                raise ValueError("Message must contain 1–8000 characters")
            if not isinstance(item, str) or not 1 <= len(item) <= 128:
                raise ValueError("Item ID must contain 1–128 characters")
            ident = str(uuid.uuid4())
            db.execute("INSERT INTO inputs(id,session,item,text) VALUES(?,?,?,?)", (ident, sid, item, text))
            event(db, sid, "enqueued", {"id": ident, "item": item})
            result = {"id": ident, "session": sid, "item": item}
        elif action == "status":
            result = {"session": dict(row) if row else None,
                      "inputs": [dict(r) for r in db.execute("SELECT * FROM inputs WHERE session=? ORDER BY seq", (sid,))],
                      "events": [dict(r) | {"data": json.loads(r["data"])} for r in db.execute("SELECT * FROM events WHERE session=? ORDER BY seq", (sid,))]}
        else:
            if not row or request.get("generation") != row["generation"]:
                raise ValueError("Stale or unbound bridge generation")
            if action == "claim":
                outstanding = db.execute("SELECT 1 FROM inputs WHERE session=? AND state IN ('claimed','running','failed')", (sid,)).fetchone()
                value = None if row["paused"] or outstanding else db.execute("SELECT * FROM inputs WHERE session=? AND state='queued' ORDER BY seq LIMIT 1", (sid,)).fetchone()
                result = dict(value) if value else None
                if value:
                    db.execute("UPDATE inputs SET state='claimed',generation=? WHERE id=?", (row["generation"], value["id"]))
                    event(db, sid, "claimed", {"id": value["id"]})
            elif action in ("started", "completed", "submit-result", "failed"):
                value = db.execute("SELECT * FROM inputs WHERE session=? AND id=? AND generation=?", (sid, request["id"], row["generation"])).fetchone()
                if not value:
                    raise ValueError("Input does not belong to this session and generation")
                if action == "started":
                    if value["state"] != "claimed":
                        raise ValueError("Input is not awaiting a start")
                    db.execute("UPDATE inputs SET state='running',turn=? WHERE id=?", (request["turnId"], value["id"]))
                elif action == "completed":
                    if value["state"] != "running" or request["turnId"] != value["turn"]:
                        raise ValueError("Completion does not match the input's running turn")
                    ok = request.get("reason") == "answer" and not request.get("isAborted")
                    db.execute("UPDATE inputs SET state=?,answer=? WHERE id=?", ("done" if ok else "failed", request.get("answer", ""), value["id"]))
                    if not ok:
                        db.execute("UPDATE sessions SET paused=1 WHERE id=?", (sid,))
                elif action == "failed":
                    db.execute("UPDATE inputs SET state='failed' WHERE id=? AND state!='done'", (value["id"],))
                    db.execute("UPDATE sessions SET paused=1 WHERE id=?", (sid,))
                event(db, sid, action, {k: v for k, v in request.items() if k not in ("session", "generation")})
                result = {"ok": True}
            elif action == "disconnected":
                db.execute("UPDATE sessions SET paused=1 WHERE id=?", (sid,))
                event(db, sid, action, {})
                result = {"ok": True}
            else:
                raise ValueError("Unknown operation")
        db.commit()
        return result
    except Exception:
        db.rollback()
        raise


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", default=".")
    parser.add_argument("action", choices=["connect", "enqueue", "status", "claim", "started", "completed", "submit-result", "failed", "disconnected"])
    parser.add_argument("--session")
    parser.add_argument("--item", default="finding-1")
    parser.add_argument("--text")
    args = parser.parse_args()
    request = {"session": args.session, "item": args.item, "text": args.text} if args.session else json.load(sys.stdin)
    try:
        with connect(args.project) as db:
            result = operate(db, args.action, request)
        print(json.dumps(result, indent=2))
    except (ValueError, KeyError, sqlite3.Error) as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
