"""Execute CI orchestration without claiming command doubles prove app checks."""
import json
import os
import re
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
    assert toolchain_home.is_dir() and toolchain_home.name == "ariadne-rustup"
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
        self.assertIn("matrix:\n        stage: [static, coverage, native]", workflow)
        self.assertIn("fail-fast: false", workflow)
        self.assertIn("  quality:\n    name: quality\n    needs: [stage]\n    if: ${{ !cancelled() }}\n    runs-on: ubuntu-latest", workflow)
        self.assertIn("- name: Record result\n        if: always()", workflow)
        self.assertIn('[[ "$STAGE_RESULT" == "success" ]]', workflow)
        self.assertIn("-${{ matrix.stage }}\n", workflow)
        self.assertIn("package-manager-cache: true", workflow)
        self.assertIn("uses: Swatinem/rust-cache@", workflow)
        self.assertIn('key: ${{ matrix.stage }}\n          workspaces: ". -> target/native-e2e"\n'
                      "          cache-on-failure: true", workflow)
        self.assertNotIn("save-if", workflow)
        self.assertIn("path: ~/.cargo/bin/cargo-llvm-cov\n          key: ${{ runner.os }}-cargo-llvm-cov-0.9.1", workflow)
        self.assertIn("steps.llvm-cov-cache.outputs.cache-hit != 'true'", workflow)
        self.assertEqual(workflow.count("&& matrix.stage != 'static'"), 2)
        self.assertIn("      - name: Check the pushed branch head\n"
                      "        if: contains(steps.scope.outputs.scope, 'application') || matrix.stage == 'static'\n", workflow)
        self.assertIn("      - name: Preserve native and coverage evidence\n"
                      "        if: always() && (contains(steps.scope.outputs.scope, 'application') || matrix.stage == 'static')\n",
                      workflow)
        order = [workflow.index(f"      - name: {name}\n") for name in (
            "Resolve the check scope", "Install the Rust toolchain", "Restore cargo-llvm-cov",
            "Install cargo-llvm-cov", "Cache the Rust build", "Check the pushed branch head")]
        self.assertEqual(order, sorted(order))

        def step_script(name):
            step = workflow.split(f"      - name: {name}\n", 1)[1]
            body = step.split("        run: |\n", 1)[1]
            body = re.split(r"      - (?:name|uses):", body, maxsplit=1)[0]
            return "\n".join(line.removeprefix("          ") for line in body.splitlines())

        steps = [("Resolve the check scope", lambda application, stage: True),
                 ("Install the Rust toolchain", lambda application, stage: application),
                 ("Install cargo-llvm-cov", lambda application, stage: application and stage != "static"),
                 ("Check the pushed branch head", lambda application, stage: application or stage == "static")]
        scripts = [(step_script(name), condition) for name, condition in steps]
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
            cases = [(stage, *case) for stage in ("static", "coverage", "native") for case in cases]
            for index, (stage, scope, status, event, ref, provision_status, capture_status, setup_status) in enumerate(cases):
                with self.subTest(stage=stage, scope=scope, status=status, event=event, ref=ref, setup_status=setup_status):
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
                           "COMMAND_LOG": str(log), "SCOPE": scope, "GATE_EXIT": str(status),
                           "STAGE": stage}
                    application = scope.startswith("application")
                    github_env = checkout / "github-env"
                    github_output = checkout / "github-output"
                    env.update(GITHUB_ENV=str(github_env), GITHUB_OUTPUT=str(github_output))
                    for script, condition in scripts:
                        github_env.touch()
                        github_output.touch()
                        for line in github_env.read_text().splitlines():
                            key, _, value = line.partition("=")
                            env[key] = value
                        for line in github_output.read_text().splitlines():
                            key, _, value = line.partition("=")
                            env[key.upper()] = value
                        if not condition(application, stage):
                            continue
                        result = subprocess.run(["bash", "-c", script], cwd=checkout, env=env,
                                                text=True, capture_output=True)
                        if result.returncode:
                            break
                    reference = "reference=true" in scope and stage == "static"
                    runs_gate = application or stage == "static"
                    expected_status = setup_status or status or ((provision_status or capture_status) if reference else 0)
                    if not runs_gate:
                        expected_status = 0
                    self.assertEqual(result.returncode, expected_status, result.stderr)
                    calls = [json.loads(line) for line in log.read_text().splitlines()]
                    gate = ["python", "scripts/check-commit.py", "--ci", "--base", "whole-pr-base"]
                    if ref != "refs/heads/main":
                        gate += ["--merge-base"]
                    if event == "workflow_dispatch":
                        gate += ["--full"]
                    gate += ["--stage", stage]
                    gate_ok = not (setup_status or status)
                    self.assertEqual(calls.count(gate), int(runs_gate and not setup_status))
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
                    llvm_cov = ["cargo", "install", "cargo-llvm-cov", "--version", "0.9.1", "--locked"]
                    self.assertEqual(calls.count(llvm_cov), int(application and stage != "static" and not setup_status))
                    self.assertFalse(any(call[0] == "rtk" for call in calls))

    def test_captures_before_gate_are_rejected(self):
        workflow_path = ROOT / ".github/workflows/quality.yml"
        workflow = workflow_path.read_text()
        gate = '          .venv-quality/bin/python scripts/check-commit.py "${args[@]}" --stage "$STAGE"\n'
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
