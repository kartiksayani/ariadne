#!/usr/bin/env python3
"""Convenient external owner-message sender; no Claude process is launched."""
import argparse
import importlib.util
import json
from pathlib import Path

spec = importlib.util.spec_from_file_location("broker", Path(__file__).parent / "plugin/scripts/broker.py")
broker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(broker)

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("session", help="Session ID printed by /ariadne-connect")
parser.add_argument("text", nargs="?", help="Omit to show messages, replies and events")
parser.add_argument("--item", default="finding-1")
parser.add_argument("--project", default=str(Path(__file__).resolve().parents[2]))
args = parser.parse_args()
with broker.connect(args.project) as db:
    result = broker.operate(db, "enqueue" if args.text is not None else "status",
                            {"session": args.session, "text": args.text, "item": args.item})
print(json.dumps(result, indent=2))
