"""Process regression: real ESLint must fail even when legacy npm returns success."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class PlanningLintTests(unittest.TestCase):
    def test_baseline_passes_but_undefined_inline_name_fails_without_npm(self):
        with tempfile.TemporaryDirectory(prefix="ariadne-lint-regression-") as directory:
            root = Path(directory) / "project"
            shutil.copytree(ROOT, root, ignore=shutil.ignore_patterns(
                ".git", ".npmrc", ".env*", "secrets", "node_modules", ".venv-quality", ".cache",
                "coverage", "target", "__pycache__", "*.pyc"))
            (root / "node_modules").symlink_to((ROOT / "node_modules").resolve(), target_is_directory=True)
            fake_bin = Path(directory) / "bin"
            fake_bin.mkdir()
            marker = Path(directory) / "npm-invoked"
            npm = fake_bin / "npm"
            npm.write_text(f"#!/bin/sh\n: > '{marker}'\nprintf 'legacy npm swallowed a configuration error\\n'\nexit 0\n")
            npm.chmod(0o755)
            environment = {**os.environ, "PATH": str(fake_bin) + os.pathsep + os.environ["PATH"]}

            def validate():
                result = subprocess.run([sys.executable, str(root / "scripts/validate-planning.py")],
                                        cwd=root, env=environment, capture_output=True, text=True)
                report = json.loads((root / ".cache/planning-validation.json").read_text())
                return result, report

            baseline, baseline_report = validate()
            self.assertEqual(baseline.returncode, 0, baseline.stderr + baseline.stdout)
            self.assertTrue(baseline_report["checks"]["explorer_javascript_lint"])
            explorer = root / "docs/planning/communication-explorer.html"
            original = explorer.read_text()
            explorer.write_text(original.replace("</script>", "\nmissingLintName();\n</script>", 1))
            negative, negative_report = validate()
            self.assertEqual(negative.returncode, 1, negative.stderr + negative.stdout)
            self.assertFalse(negative_report["checks"]["explorer_javascript_lint"])
            self.assertFalse(negative_report["passed"])
            self.assertTrue(negative_report["checks"]["explorer_javascript_syntax"])
            self.assertTrue(negative_report["checks"]["explorer_12_flow_cases"])
            self.assertIn("missingLintName", negative.stdout)
            self.assertFalse(marker.exists(), "The validator must never delegate lint to npm")


if __name__ == "__main__":
    unittest.main()
