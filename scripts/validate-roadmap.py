#!/usr/bin/env python3
"""Validate the authoritative task graph and offline interactive projection."""
import json
import re
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def validate():
    catalogue = json.loads((ROOT / "docs/delivery/tasks.json").read_text())
    html = (ROOT / "docs/planning/roadmap.html").read_text()
    embedded = re.search(r'<script id="roadmap-data" type="application/json">(.*?)</script>', html, re.S)
    if not embedded or json.loads(embedded[1]) != catalogue:
        raise ValueError("Chart data drift: embed the exact authoritative task catalogue")
    scripts = [re.search(r'<script id="' + name + r'">(.*?)</script>', html, re.S)[1]
               for name in ("roadmap-engine", "roadmap-ui")]
    for task in catalogue["tasks"]:
        for ref in task["spec"]:
            path, _, anchor = ref.partition("#")
            source = (ROOT / path).resolve()
            source.relative_to(ROOT)
            text = source.read_text()
            headings = re.findall(r"^#{1,6} (.+)$", text, re.M)
            anchors = {re.sub(r"[^\w\- ]", "", heading.lower()).replace(" ", "-") for heading in headings}
            if anchor and anchor not in anchors:
                raise ValueError(f"Missing spec anchor for {task['id']}: {ref}")
    subprocess.run(["node", str(ROOT / "node_modules/eslint/bin/eslint.js"), "--stdin",
                    "--stdin-filename", "docs-inline.mjs", "--max-warnings=0"],
                   input="\n".join(scripts), text=True, cwd=ROOT, check=True)
    with tempfile.TemporaryDirectory(prefix="ariadne-roadmap-") as directory:
        runner = Path(directory) / "check.cjs"
        runner.write_text(NODE_TEST)
        subprocess.run(["node", str(runner), str(ROOT / "docs/planning/roadmap.html"),
                        str(ROOT / "docs/delivery/tasks.json")], check=True)
    print(f"Roadmap: {len(catalogue['tasks'])} tasks; matching embedded data, valid links, lint and scheduling checks passed")


NODE_TEST = r"""
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const html = fs.readFileSync(process.argv[2], 'utf8');
const catalogue = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const ctx = vm.createContext({});
vm.runInContext(html.match(/<script id="roadmap-engine">([\s\S]*?)<\/script>/)[1], ctx);
const engine = ctx.ariadneRoadmap;
assert.equal(engine.validateCatalogue(catalogue), true);
const tasks = catalogue.tasks;
for (const workers of [1, 2, 3, 8]) {
  const plan = engine.schedule(tasks, workers);
  const byId = new Map(plan.tasks.map(task => [task.id, task]));
  for (const task of tasks) {
    const row = byId.get(task.id);
    assert.ok(row.end > row.start);
    for (const dependency of task.depends_on) assert.ok(byId.get(dependency).end <= row.start);
    for (const other of tasks) {
      if (other.id === task.id) continue;
      const peer = byId.get(other.id);
      const simultaneous = row.start < peer.end && peer.start < row.end;
      if (simultaneous) {
        assert.notEqual(row.lane, peer.lane);
        assert.equal(engine.ownershipOverlap(task, other), false);
      }
    }
  }
}
assert.equal(engine.schedule(tasks, 1).total_days, tasks.reduce((sum, task) => sum + task.estimate_days, 0));
assert.equal(engine.schedule(tasks, 3, tasks.map(task => task.id)).total_days, 0);
assert.throws(() => engine.schedule(tasks, 0));
assert.throws(() => engine.validateCatalogue({schema_version: 1, tasks: [...tasks, tasks[0]]}));
const cyclic = JSON.parse(JSON.stringify(catalogue));
cyclic.tasks[0].depends_on = [tasks[tasks.length - 1].id];
assert.throws(() => engine.validateCatalogue(cyclic));
assert.equal(engine.qualifiedEvidence({state: 'MERGED'}), false);
assert.equal(engine.taskStatus(tasks[0], []), 'available');
assert.equal(engine.taskStatus(tasks[0], [tasks[0].id]), 'merged');
assert.equal(engine.patternsOverlap('src/a/**', 'src/a/file.rs'), true);
assert.equal(engine.patternsOverlap('src/a/**', 'src/b/file.rs'), false);
console.log('Four worker schedules, dependency/ownership exclusion, cycles, stale evidence and completion checks passed');
"""

if __name__ == "__main__":
    validate()
