"""Execute CI orchestration without claiming command doubles prove app checks."""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
COMMAND_DOUBLE = '''import json, os, sys
from pathlib import Path
name = Path(sys.argv[0]).name
with open(os.environ["COMMAND_LOG"], "a") as output:
    output.write(json.dumps([name, *sys.argv[1:]]) + "\\n")
if name in ("rustup", "cargo", "rustc"):
    toolchain_home = Path(os.environ["RUSTUP_HOME"]).resolve()
    assert toolchain_home.parent == Path(os.environ["RUNNER_TEMP"]).resolve()
    assert toolchain_home.is_dir() and toolchain_home.name.startswith("ariadne-rustup.")
if name == "rustup":
    sys.exit(int(os.environ["SETUP_EXIT"]))
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
            for name in ("npm", "cargo", "rustc", "rustup", "node"):
                (commands / name).symlink_to(command)
            cases = [
                ("docs release=false reference=false", 0, "push", "refs/heads/docs", 23, 29),
                ("tooling release=false reference=false", 0, "push", "refs/heads/tooling", 23, 29),
                ("docs release=false reference=true", 0, "push", "refs/heads/design", 0, 0),
                ("tooling release=false reference=true", 0, "push", "refs/heads/browser-test", 0, 0),
                ("docs release=false reference=true", 0, "push", "refs/heads/design", 23, 0),
                ("tooling release=false reference=true", 0, "push", "refs/heads/browser-test", 0, 29),
                ("application release=false reference=false", 0, "push", "refs/heads/backend", 23, 29),
                ("application release=true reference=false", 17, "push", "refs/heads/backend", 23, 29),
                ("application release=true reference=true", 0, "push", "refs/heads/feature", 0, 0),
                ("application release=true reference=true", 17, "push", "refs/heads/feature", 0, 0),
                ("application release=true reference=true", 0, "push", "refs/heads/main", 0, 0),
                ("application release=true reference=true", 0, "workflow_dispatch", "refs/heads/main", 0, 0),
                ("application release=true reference=true", 0, "workflow_dispatch", "refs/heads/feature", 0, 0),
                ("application release=true reference=true", 0, "push", "refs/heads/feature", 23, 0),
                ("application release=true reference=true", 0, "push", "refs/heads/feature", 0, 29),
                ("application release=true reference=true", 17, "push", "refs/heads/feature", 23, 29),
                ("tooling release=false reference=true", 17, "push", "refs/heads/browser-test", 23, 29),
            ]
            cases = [(*case, 0) for case in cases] + [
                ("application release=true reference=true", 0, "push", "refs/heads/feature", 0, 0, 42),
            ]
            for index, (scope, status, event, ref, provision_status, capture_status, setup_status) in enumerate(cases):
                with self.subTest(scope=scope, status=status, event=event, ref=ref, setup_status=setup_status):
                    checkout = root / str(index)
                    checkout.mkdir()
                    runner_temp = checkout / "runner-temp"
                    runner_temp.mkdir()
                    log = checkout / "commands.jsonl"
                    env = {**os.environ, "PATH": str(commands) + os.pathsep + os.environ["PATH"],
                           "BASE_SHA": "whole-pr-base", "GITHUB_EVENT_NAME": event,
                           "GITHUB_REF": ref, "GITHUB_WORKSPACE": str(checkout),
                           "RUNNER_TEMP": str(runner_temp), "SETUP_EXIT": str(setup_status),
                           "PROVISION_EXIT": str(provision_status), "CAPTURE_EXIT": str(capture_status),
                           "COMMAND_LOG": str(log), "SCOPE": scope, "GATE_EXIT": str(status)}
                    result = subprocess.run(["bash", "-c", script], cwd=checkout, env=env,
                                            text=True, capture_output=True)
                    application = scope.startswith("application")
                    reference = "reference=true" in scope
                    expected_status = setup_status or status or ((provision_status or capture_status) if reference else 0)
                    self.assertEqual(result.returncode, expected_status, result.stderr)
                    calls = [json.loads(line) for line in log.read_text().splitlines()]
                    gate = ["python", "scripts/check-commit.py", "--ci", "--base", "whole-pr-base"]
                    if ref != "refs/heads/main":
                        gate += ["--merge-base"]
                    if event == "workflow_dispatch":
                        gate += ["--full"]
                    gate_ok = not (setup_status or status)
                    self.assertEqual(calls.count(gate), int(not setup_status))
                    provisioning = ["node", "node_modules/playwright/cli.js", "install", "chromium"]
                    capture = ["npm", "run", "capture:reference"]
                    self.assertEqual(calls.count(provisioning), int(reference and gate_ok))
                    self.assertEqual(calls.count(capture), int(reference and gate_ok and not provision_status))
                    if reference and gate_ok and not provision_status:
                        self.assertLess(calls.index(provisioning), calls.index(capture))
                    if reference and gate_ok:
                        self.assertLess(calls.index(gate), calls.index(provisioning))
                    installs = [call for call in calls if call[0] == "rustup"]
                    self.assertEqual(len(installs), int(application))
                    version_checks = [[name, "--version"] for name in ("cargo", "rustc")]
                    for version in version_checks:
                        self.assertEqual(calls.count(version), int(application and not setup_status))
                    if application and not setup_status:
                        for version in version_checks:
                            self.assertLess(calls.index(installs[0]), calls.index(version))
                        self.assertLess(calls.index(version_checks[-1]), calls.index(gate))
                    self.assertFalse(any(call[0] == "rtk" for call in calls))

    def test_captures_before_gate_are_rejected(self):
        workflow_path = ROOT / ".github/workflows/quality.yml"
        workflow = workflow_path.read_text()
        gate = '          .venv-quality/bin/python scripts/check-commit.py "${args[@]}"\n'
        self.assertEqual(workflow.count(gate), 1)
        next_step = "      - name: Preserve native and coverage evidence\n"
        mutation = workflow.replace(gate, "").replace(next_step, gate + next_step)
        original_read_text = Path.read_text

        def read_text(path, *args, **kwargs):
            return mutation if path == workflow_path else original_read_text(path, *args, **kwargs)

        result = unittest.TestResult()
        fixture = QualityWorkflowTests("test_single_push_head_scope_and_failures_are_reported")
        with patch.object(Path, "read_text", read_text):
            fixture.run(result)
        self.assertFalse(result.errors, result.errors)
        self.assertTrue(result.failures, "Workflow matrix accepted captures before the required gate")
