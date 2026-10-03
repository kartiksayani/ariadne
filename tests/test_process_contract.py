"""Run actual Node process-helper contracts through the installed quality hook."""
import subprocess
import unittest
from pathlib import Path


class ProcessContracts(unittest.TestCase):
    def test_real_process_contracts(self):
        root = Path(__file__).resolve().parents[1]
        subprocess.run(["node", "--test", "tests/e2e/process-contract/runner.test.mjs"], cwd=root, check=True)
