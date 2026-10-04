"""Exercise the real frontend report against the existing source inventory policy."""
import importlib.util
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("frontend_commit", ROOT / "scripts/check-commit.py")
COMMIT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(COMMIT)


class FrontendCoverage(unittest.TestCase):
    def test_real_generated_outputs_are_excluded_and_uncovered_handwritten_source_remains(self):
        with tempfile.TemporaryDirectory(prefix="ariadne-frontend-coverage-") as folder:
            root = Path(folder)
            desktop = root / "apps/desktop"
            generated = desktop / "src/nested/generated"
            generated.mkdir(parents=True)
            (desktop / "src/notgenerated").mkdir()
            (desktop / "tests/ui").mkdir(parents=True)
            (root / "package.json").write_text('{"type":"module"}\n')
            (root / "node_modules").symlink_to(ROOT / "node_modules", target_is_directory=True)
            shutil.copyfile(ROOT / "apps/desktop/vite.config.ts", desktop / "vite.config.ts")
            shutil.copyfile(ROOT / "quality-gates.json", root / "quality-gates.json")
            # Actual pinned compiler outputs, not a claim about the domain generator.
            generator = """
const ts = require('typescript');
const fs = require('node:fs');
const source = 'export type Widget = { title: string }; export const generatedValue: number = 7;';
const options = { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } };
const types = ts.transpileDeclaration(source, options);
const executable = ts.transpileModule(source, options);
if ([...types.diagnostics, ...executable.diagnostics].length) throw new Error('Compiler diagnostics');
fs.writeFileSync(process.argv[1] + '/types.ts', types.outputText);
fs.writeFileSync(process.argv[1] + '/runtime.ts', executable.outputText);
"""
            subprocess.run(["node", "-e", generator, str(generated)], cwd=ROOT, check=True, timeout=30)
            self.assertIn("export type Widget", (generated / "types.ts").read_text())
            self.assertIn("export const generatedValue = 7", (generated / "runtime.ts").read_text())
            (desktop / "src/executed.ts").write_text("export const answer = () => 42;\n")
            (desktop / "src/notgenerated/uncovered.ts").write_text("export const uncovered = () => 99;\n")
            (desktop / "tests/ui/coverage.test.tsx").write_text(
                "import { expect, it } from 'vitest';\n"
                "import { answer } from '../../src/executed';\n"
                "import { generatedValue } from '../../src/nested/generated/runtime';\n"
                "it('executes handwritten and compiler output', () => {\n"
                "  expect(answer()).toBe(42);\n"
                "  expect(generatedValue).toBe(7);\n"
                "});\n"
            )
            command = ["node", str(ROOT / "node_modules/vitest/vitest.mjs"), "run", "--coverage",
                       "--config", str(desktop / "vite.config.ts")]
            completed = subprocess.run(command, cwd=root, env={**os.environ, "VITE_ARIADNE_E2E": "0"},
                                       text=True, capture_output=True, timeout=120)
            self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
            report = root / "coverage/web/lcov.info"
            records = {}
            for block in report.read_text().split("end_of_record"):
                lines = block.splitlines()
                source = next((line[3:] for line in lines if line.startswith("SF:")), None)
                if source:
                    records[source] = [int(line.split(",")[1]) for line in lines if line.startswith("DA:")]
            expected = {"apps/desktop/src/executed.ts", "apps/desktop/src/notgenerated/uncovered.ts"}
            self.assertEqual(set(records), expected)
            self.assertTrue(any(records["apps/desktop/src/executed.ts"]))
            uncovered = records["apps/desktop/src/notgenerated/uncovered.ts"]
            self.assertTrue(uncovered)
            self.assertEqual(set(uncovered), {0})
            config = {"coverage_exclusions": ["apps/desktop/vite.config.ts"]}
            inventory, excluded = COMMIT.coverage_policy(root, config)
            self.assertEqual(inventory - excluded, expected)
            covered, total = COMMIT.coverage_counts([report], root, config)
            self.assertEqual(covered, sum(hit > 0 for hits in records.values() for hit in hits))
            self.assertEqual(total, sum(map(len, records.values())))
            self.assertLess(covered, total)
