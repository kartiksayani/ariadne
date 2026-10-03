"""Execute CI orchestration without claiming command doubles prove app checks."""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
COMMAND_DOUBLE = '''import json, os, sys
from pathlib import Path
name = Path(sys.argv[0]).name
with open(os.environ["COMMAND_LOG"], "a") as output:
    output.write(json.dumps([name, *sys.argv[1:]]) + "\\n")
if name == "python" and sys.argv[1:3] == ["-m", "venv"]:
    target = Path(sys.argv[3]) / "bin/python"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.symlink_to(Path(sys.argv[0]).resolve())
if name == "python" and sys.argv[1:2] == ["scripts/check-commit.py"]:
    if "--print-scope" in sys.argv:
        print(os.environ["SCOPE"])
    else:
        sys.exit(int(os.environ["GATE_EXIT"]))
if name == "node" and sys.argv[1:] == ["node_modules/playwright/cli.js", "install", "chromium"]:
    assert Path(os.environ["PLAYWRIGHT_BROWSERS_PATH"]).resolve() == Path.cwd() / "target/reference-browser"
    sys.exit(int(os.environ["PROVISION_EXIT"]))
if name == "npm" and sys.argv[1:] == ["run", "capture:reference"]:
    sys.exit(int(os.environ["CAPTURE_EXIT"]))
'''


class QualityWorkflowTests(unittest.TestCase):
    def test_single_push_head_scope_and_failures_are_reported(self):
        workflow = (ROOT / ".github/workflows/quality.yml").read_text()
        self.assertIn('on:\n  push:\n    branches: ["**"]\n', workflow)
        self.assertNotIn("pull_request:", workflow)
        self.assertNotIn("change-policy:", workflow)
        self.assertNotIn("paths:", workflow)
        self.assertIn("group: quality-${{ github.ref }}\n  cancel-in-progress: true", workflow)
        self.assertIn("github.event.before || 'origin/main'", workflow)
        self.assertIn("- name: Record result\n        if: always()", workflow)
        step = workflow.split("      - name: Check the pushed branch head\n", 1)[1]
        script = "\n".join(line.removeprefix("          ") for line in
                           step.split("        run: |\n", 1)[1].split("      - name:", 1)[0].splitlines())
        with tempfile.TemporaryDirectory(prefix="ariadne-ci-orchestration-") as folder:
            root = Path(folder)
            commands = root / "commands"
            commands.mkdir()
            command = commands / "python"
            command.write_text(f"#!{sys.executable}\n" + COMMAND_DOUBLE)
            command.chmod(0o755)
            for name in ("npm", "cargo", "rustup", "node"):
                (commands / name).symlink_to(command)
            for index, (scope, status, event, ref, provision_status, capture_status) in enumerate([
                ("docs release=false", 0, "push", "refs/heads/docs", 23, 29),
                ("tooling release=false", 0, "push", "refs/heads/tooling", 23, 29),
                ("application release=true", 0, "push", "refs/heads/feature", 0, 0),
                ("application release=true", 17, "push", "refs/heads/feature", 0, 0),
                ("application release=true", 0, "push", "refs/heads/main", 0, 0),
                ("application release=true", 0, "workflow_dispatch", "refs/heads/main", 0, 0),
                ("application release=true", 0, "workflow_dispatch", "refs/heads/feature", 0, 0),
                ("application release=true", 0, "push", "refs/heads/feature", 23, 0),
                ("application release=true", 0, "push", "refs/heads/feature", 0, 29),
            ]):
                with self.subTest(scope=scope, status=status, event=event, ref=ref):
                    checkout = root / str(index)
                    checkout.mkdir()
                    log = checkout / "commands.jsonl"
                    env = {**os.environ, "PATH": str(commands) + os.pathsep + os.environ["PATH"],
                           "BASE_SHA": "whole-pr-base", "GITHUB_EVENT_NAME": event,
                           "GITHUB_REF": ref, "GITHUB_WORKSPACE": str(checkout),
                           "PROVISION_EXIT": str(provision_status), "CAPTURE_EXIT": str(capture_status),
                           "COMMAND_LOG": str(log), "SCOPE": scope, "GATE_EXIT": str(status)}
                    result = subprocess.run(["bash", "-c", script], cwd=checkout, env=env,
                                            text=True, capture_output=True)
                    application = scope.startswith("application")
                    expected_status = (provision_status or capture_status or status) if application else status
                    self.assertEqual(result.returncode, expected_status, result.stderr)
                    calls = [json.loads(line) for line in log.read_text().splitlines()]
                    gate = ["python", "scripts/check-commit.py", "--ci", "--base", "whole-pr-base"]
                    if ref != "refs/heads/main":
                        gate += ["--merge-base"]
                    if event == "workflow_dispatch":
                        gate += ["--full"]
                    capture_ok = not application or not (provision_status or capture_status)
                    self.assertEqual(calls.count(gate), int(capture_ok))
                    provisioning = ["node", "node_modules/playwright/cli.js", "install", "chromium"]
                    capture = ["npm", "run", "capture:reference"]
                    self.assertEqual(calls.count(provisioning), int(application))
                    self.assertEqual(calls.count(capture), int(application and not provision_status))
                    if application and not provision_status:
                        self.assertLess(calls.index(provisioning), calls.index(capture))
                    if application and capture_ok:
                        self.assertLess(calls.index(capture), calls.index(gate))
                    installs = [call for call in calls if call[0] == "rustup"]
                    self.assertEqual(bool(installs), application and capture_ok)
                    self.assertFalse(any(call[0] == "rtk" for call in calls))
