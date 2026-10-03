"""Execute CI shell orchestration; command doubles do not claim application passes."""
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
if name == "python" and sys.argv[1:] == ["scripts/check-commit.py", "--ci"]:
    Path("coverage").mkdir()
    Path("coverage/orchestration.txt").write_text(os.environ["GITHUB_SHA"])
    sys.exit(int(os.environ["GATE_EXIT"]))
'''


class QualityWorkflowTests(unittest.TestCase):
    def test_pushed_feature_head_and_main_run_once_and_archive_gate_failure(self):
        workflow = (ROOT / ".github/workflows/quality.yml").read_text()
        self.assertIn('on:\n  push:\n    branches: ["**"]\n', workflow)
        self.assertNotIn("pull_request:", workflow)
        self.assertIn("group: quality-${{ github.ref }}\n  cancel-in-progress: true", workflow)
        quality = workflow.split("\n  quality:\n", 1)[1]
        check = quality.split("      - name: Check the pushed branch head\n", 1)[1]
        script = "\n".join(line.removeprefix("          ") for line in
                           check.split("        run: |\n", 1)[1].split("      - name:", 1)[0].splitlines())
        self.assertNotIn("git checkout", quality)
        self.assertNotIn("git rev-list", quality)
        self.assertNotIn("ref:", quality.split("      - uses: actions/setup-python", 1)[0])
        self.assertIn("if: always()\n        uses: actions/upload-artifact@", quality)
        with tempfile.TemporaryDirectory(prefix="ariadne-ci-orchestration-") as directory:
            root = Path(directory)
            repository = root / "repository"
            repository.mkdir()
            tools = root / "commands"
            tools.mkdir()
            command = tools / "python"
            command.write_text(f"#!{sys.executable}\n" + COMMAND_DOUBLE)
            command.chmod(0o755)
            for name in ("npm", "sw_vers", "uname", "xcode-select", "xcodebuild", "rustup", "cargo"):
                (tools / name).symlink_to(command)
            env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
            env.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull,
                       GIT_CONFIG_SYSTEM=os.devnull, GIT_CONFIG_COUNT="1",
                       GIT_CONFIG_KEY_0="core.hooksPath", GIT_CONFIG_VALUE_0=os.devnull,
                       PATH=str(tools) + os.pathsep + os.environ["PATH"])

            def git(*args):
                return subprocess.run(["git", *args], cwd=repository, env=env, check=True,
                                      text=True, capture_output=True).stdout.strip()

            git("init", "-qb", "main")
            git("config", "user.name", "CI Orchestration Test")
            git("config", "user.email", "ci@example.invalid")
            (repository / "Cargo.toml").write_text("# Presence selects native build orchestration.\n")
            git("add", "Cargo.toml")
            git("commit", "-qm", "base")
            base = git("rev-parse", "HEAD")
            git("checkout", "-qb", "feature")
            for number in range(3):
                (repository / "source.txt").write_text(str(number))
                git("add", "source.txt")
                git("commit", "-qm", f"feature {number}")
            head = git("rev-parse", "HEAD")
            git("checkout", "-q", "main")
            git("merge", "--squash", "feature")
            git("commit", "-qm", "Squash feature")
            main = git("rev-parse", "HEAD")
            self.assertEqual(len(git("rev-list", f"{base}..{head}").splitlines()), 3)
            for ref, revision, status in (("feature", head, 0), ("main", main, 0), ("feature", head, 17)):
                with self.subTest(ref=ref, status=status):
                    git("checkout", "--detach", revision)
                    runner = root / f"{ref}-{status}"
                    runner.mkdir()
                    log = runner / "commands.jsonl"
                    gate_env = {**env, "GITHUB_EVENT_NAME": "push", "GITHUB_REF": f"refs/heads/{ref}",
                                "BASE_SHA": base, "HEAD_SHA": revision,
                                "GITHUB_SHA": revision, "RUNNER_TEMP": str(runner),
                                "COMMAND_LOG": str(log), "GATE_EXIT": str(status)}
                    result = subprocess.run(["bash", "-c", script], cwd=repository, env=gate_env,
                                            text=True, capture_output=True)
                    self.assertEqual(result.returncode, status, result.stderr)
                    calls = [json.loads(line) for line in log.read_text().splitlines()]
                    self.assertEqual(calls.count(["python", "scripts/check-commit.py", "--ci"]), 1)
                    self.assertEqual(calls.count(["cargo", "build", "--workspace", "--locked", "--all-features"]), 1)
                    self.assertEqual(git("rev-parse", "HEAD"), revision)
                    archives = list((runner / "ariadne-quality-evidence").iterdir())
                    self.assertEqual([path.name for path in archives], [revision])
                    self.assertEqual((archives[0] / "orchestration.txt").read_text(), revision)
                    (repository / ".venv-quality/bin/python").unlink()


if __name__ == "__main__":
    unittest.main()
