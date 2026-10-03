#!/usr/bin/env python3
"""Regenerate the embedded static roadmap data from its single source."""
import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Fail if embedded data is stale; do not write")
    args = parser.parse_args()
    chart = ROOT / "docs/planning/roadmap.html"
    before = chart.read_text()
    prefix, rest = before.split('<script id="roadmap-data" type="application/json">', 1)
    _, suffix = rest.split("</script>", 1)
    data = json.loads((ROOT / "docs/delivery/tasks.json").read_text())
    after = prefix + '<script id="roadmap-data" type="application/json">' + json.dumps(data, indent=2, ensure_ascii=False) + "</script>" + suffix
    if args.check:
        if before != after:
            raise SystemExit("Roadmap data is stale: run python3 scripts/regenerate-roadmap.py")
    else:
        chart.write_text(after)


if __name__ == "__main__":
    main()
