#!/usr/bin/env python3
"""Validate planning artifacts only; this is not an application test suite."""
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
from urllib.parse import unquote
import zipfile

ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / "docs/planning"
checks = {}
errors = []


def check(name, condition, detail=None):
    checks[name] = bool(condition)
    if not condition:
        errors.append({"check": name, "detail": detail})


manifest = json.loads((DOCS / "assets/design-manifest.json").read_text())
archive = ROOT / manifest["source_archive"]["path"]
check("original_zip_checksum", hashlib.sha256(archive.read_bytes()).hexdigest()
      == manifest["source_archive"]["sha256"])
with zipfile.ZipFile(archive) as source:
    members = {m["path"]: m for m in manifest["members"]}
    check("zip_member_inventory", set(members) == set(source.namelist()))
    check("all_16_member_checksums", len(members) == 16 and all(
        len(source.read(name)) == m["uncompressed_bytes"]
        and hashlib.sha256(source.read(name)).hexdigest() == m["sha256"]
        for name, m in members.items()))
    board = source.read("design_handoff_ariadne/Ariadne Mockups.dc.html").decode()
    frame_ids = set(re.findall(r'id="(1[a-z]+)"', board))
trace = (DOCS / "DESIGN_TRACEABILITY.md").read_text()
mapped = set(re.findall(r"^\| (1[a-z]+) \|", trace, re.M))
check("all_30_design_frames_mapped", len(frame_ids) == 30 and frame_ids == mapped,
      {"missing": sorted(frame_ids - mapped), "extra": sorted(mapped - frame_ids)})

bad_links = []
json_blocks = 0
markdown_files = [ROOT / "README.md", ROOT / "DECISIONS.md", *DOCS.rglob("*.md")]
for path in markdown_files:
    content = path.read_text()
    for block in re.findall(r"```json\s*\n(.*?)\n```", content, re.S):
        try:
            json.loads(block)
            json_blocks += 1
        except json.JSONDecodeError as error:
            errors.append({"file": str(path.relative_to(ROOT)), "json_error": str(error)})
    prose = re.sub(r"```.*?```", "", content, flags=re.S)
    for target in re.findall(r"!?\[[^\]]*\]\(([^)]+)\)", prose):
        target = target.strip().strip("<>").split("#", 1)[0]
        if not target or re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*:", target):
            continue
        if not (path.parent / unquote(target)).exists():
            bad_links.append({"file": str(path.relative_to(ROOT)), "target": target})
check("local_markdown_links_exist", not bad_links, bad_links)
check("json_examples_parse", not any("json_error" in e for e in errors))

html = (DOCS / "communication-explorer.html").read_text()
script = re.search(r"<script>(.*?)</script>", html, re.S).group(1)
engine = script[:script.index("const $=id=>")]
test = r"""
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(process.argv[2], 'utf8'), ctx);
let cases = 0;
for (const provider of ['claude','codex','future']) {
  for (const scenario of ['normal','missing','offline','race']) {
    const s = ctx.createSimulation(provider, scenario);
    let steps = 0;
    while (!s.state.done && !s.state.paused && steps++ < 100) {
      s.step();
      const active = s.state.inputs.filter(i =>
        ['in_flight','accepted','running','awaiting_result','result_published','ready_to_join'].includes(i.state));
      assert.ok(active.length <= 1, 'one in-flight input');
      s.state.inputs.filter(i => i.state === 'handled').forEach(i => assert.ok(i.turn && i.result && i.turn.attempt_id === i.attempt && i.result.attempt_id === i.attempt && i.result.input_id === i.id));
    }
    assert.ok(steps < 100, 'simulation terminates');
    if (scenario === 'normal' || scenario === 'race') {
      assert.ok(s.state.inputs.every(i => i.state === 'handled'));
      assert.equal(s.state.messages.filter(m => m.author === 'Agent').length, 5);
      assert.equal(s.state.messages.filter(m => m.author === 'Owner').length, 5);
      assert.equal(s.state.children.length, 2);
      assert.equal(s.state.topics.length, 2);
    } else if (scenario === 'missing') {
      assert.equal(s.state.inputs[0].state, 'needs_attention');
      assert.equal(s.state.messages.filter(m => m.author === 'Agent').length, 0, 'no inferred reply');
      assert.ok(s.state.inputs.slice(1).every(i => i.state === 'queued'));
    } else {
      assert.ok(s.state.inputs.every(i => i.state === 'queued'));
      assert.equal(s.state.messages.filter(m => m.author === 'Agent').length, 0);
    }
    cases++;
  }
}
console.log(JSON.stringify({cases, passed:true}));
"""
with tempfile.TemporaryDirectory(prefix="ariadne-planning-") as tmp:
    tmp = Path(tmp)
    (tmp / "explorer.js").write_text(script)
    (tmp / "engine.js").write_text(engine)
    (tmp / "check.cjs").write_text(test)
    prefix = ["rtk", "proxy"] if shutil.which("rtk") else []
    lint = subprocess.run([*prefix, "node", str(ROOT / "node_modules/eslint/bin/eslint.js"), "--stdin",
                           "--stdin-filename", "docs-inline.mjs", "--max-warnings=0"],
                          input=script, capture_output=True, text=True, cwd=ROOT)
    check("explorer_javascript_lint", lint.returncode == 0, lint.stdout + lint.stderr)
    syntax = subprocess.run([*prefix, "node", "--check", str(tmp / "explorer.js")],
                            capture_output=True, text=True)
    check("explorer_javascript_syntax", syntax.returncode == 0, syntax.stderr)
    result = subprocess.run([*prefix, "node", str(tmp / "check.cjs"), str(tmp / "engine.js")],
                            capture_output=True, text=True)
    check("explorer_12_flow_cases", result.returncode == 0, result.stderr)

if (ROOT / "docs/delivery/tasks.json").exists() or (DOCS / "roadmap.html").exists():
    roadmap = subprocess.run([sys.executable, str(ROOT / "scripts/validate-roadmap.py")],
                             capture_output=True, text=True)
    check("roadmap_catalogue_and_schedule", roadmap.returncode == 0, roadmap.stdout + roadmap.stderr)

report = {"scope": "planning artifacts; not production/native/browser-rendering tests",
          "checks": checks, "markdown_files": len(markdown_files),
          "json_examples": json_blocks, "design_frames": len(frame_ids),
          "errors": errors, "passed": all(checks.values()) and not errors}
(ROOT / ".cache").mkdir(exist_ok=True)
(ROOT / ".cache/planning-validation.json").write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps(report, indent=2))
raise SystemExit(0 if report["passed"] else 1)
