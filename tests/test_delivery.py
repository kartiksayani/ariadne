"""Subprocess GitHub adapter tests against genuine isolated temporary Git history."""
import contextlib
import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
SPEC = importlib.util.spec_from_file_location("delivery", ROOT / "scripts/delivery.py")
delivery = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(delivery)
GH = '''import json,os,sys
from pathlib import Path
path=Path(os.environ['FAKE_GH_STATE']); s=json.loads(path.read_text()); args=sys.argv[1:]
assert args[:2]==['api','graphql'], 'Read-only adapter attempted a mutation'
if s.get('error'): print(json.dumps({'errors':[{'message':'unavailable'}]})); sys.exit(0)
if any('pullRequests(' in a for a in args): result={'repository':{'pullRequests':s['list']}}
else: result=s['data']
print(json.dumps({'data':result}))
'''


class AdapterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "repo"
        self.root.mkdir()
        self.real_git = shutil.which("git")
        self.environment = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
        self.environment.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull,
                                GIT_CONFIG_COUNT="1", GIT_CONFIG_KEY_0="core.hooksPath", GIT_CONFIG_VALUE_0=os.devnull)
        self.git("init", "-q", "-b", "main")
        self.git("config", "user.name", "Fixture")
        self.git("config", "user.email", "fixture@example.invalid")
        self.git("commit", "-qm", "base", "--allow-empty")
        base = self.git("rev-parse", "HEAD")
        self.git("checkout", "-qb", "task")
        (self.root / "src").mkdir()
        (self.root / "src/one.rs").write_text("fixture\n")
        self.git("add", ".")
        self.git("commit", "-qm", "task")
        head = self.git("rev-parse", "HEAD")
        self.origin = Path(self.temp.name) / "origin.git"
        self.git("clone", "-q", "--bare", str(self.root), str(self.origin))
        self.git("--git-dir", str(self.origin), "update-ref", "refs/pull/1/head", head)
        self.git("remote", "add", "origin", "git@github.com:kartiksayani/ariadne.git")
        self.task = dict(id="P0.1", depends_on=[], paths=["src/**"], spec=["docs/spec.md"])
        event = dict(id="R1", head=head, agent="independent", round=1)
        self.record = dict(task_id="P0.1", head=head, base=base, authors=["author"], reviews=[event], decisions=[],
                           spec_review=dict(sections=self.task["spec"], conclusion="Accepted behavior checked."))
        payload = dict(head=head, agent="independent", round=1, model="gpt-6.1-sol", effort="high", findings=[])
        def connection(data):
            return dict(nodes=data, pageInfo=dict(hasNextPage=False))
        checks = connection([dict(__typename="CheckRun", name=name, status="COMPLETED", conclusion="SUCCESS", checkSuite=dict(app=dict(slug="github-actions"))) for name in ("quality", "change-policy")])
        self.pr = dict(number=1, url="https://github.com/kartiksayani/ariadne/pull/1", state="OPEN", body="<!-- ariadne-task:P0.1 -->",
                       isDraft=False, mergeable="MERGEABLE", baseRefName="main", headRefOid=head, headRepository=dict(nameWithOwner=delivery.REPO),
                       mergedAt=None, mergeCommit=None, commits=dict(nodes=[dict(commit=dict(oid=head, statusCheckRollup=dict(state="SUCCESS", contexts=checks)))]),
                       reviews=connection([dict(id="R1", state="COMMENTED", body="```ariadne-review\n"+json.dumps(payload)+"\n```", submittedAt="2026-10-02T00:00:00Z", author=dict(login="kartiksayani"), commit=dict(oid=head))]),
                       files=connection([dict(path="src/one.rs")]), comments=connection([]), reviewThreads=connection([]))
        self.state = dict(data=dict(viewer=dict(login="kartiksayani"), repository=dict(defaultBranchRef=dict(name="main", target=dict(oid=base)), pullRequest=self.pr)),
                          list=dict(nodes=[dict(number=1, body=self.pr["body"], state="OPEN")], pageInfo=dict(hasNextPage=False)))
        self.state_path = Path(self.temp.name) / "state.json"
        bin_dir = Path(self.temp.name) / "bin"
        bin_dir.mkdir()
        self.executable(bin_dir / "gh", GH)
        self.executable(bin_dir / "git", f"import subprocess,sys\na=sys.argv[1:]\nif a and a[0]=='fetch': a[2]={str(self.origin)!r}\nsys.exit(subprocess.call([{self.real_git!r},*a]))\n")
        self.environment.update(PATH=str(bin_dir)+os.pathsep+os.environ["PATH"], FAKE_GH_STATE=str(self.state_path),
                                REAL_GIT=self.real_git, FIXTURE_ORIGIN=str(self.origin))
        patch = mock.patch.dict(os.environ, self.environment, clear=True)
        patch.start()
        self.addCleanup(patch.stop)
        patch = mock.patch.object(delivery, "ROOT", self.root)
        patch.start()
        self.addCleanup(patch.stop)
        (self.root / "docs/delivery").mkdir(parents=True)
        (self.root / "docs/delivery/tasks.json").write_text(json.dumps(dict(tasks=[self.task])))
        self.record_path = self.root / "record.json"

    def git(self, *args):
        return subprocess.run([self.real_git, *args], cwd=self.root, env=self.environment, check=True, capture_output=True, text=True).stdout.strip()

    def executable(self, path, code):
        path.write_text(f"#!{sys.executable}\n"+code)
        path.chmod(0o755)

    def invoke(self, *args):
        self.state_path.write_text(json.dumps(self.state))
        self.record_path.write_text(json.dumps(self.record))
        with contextlib.redirect_stdout(io.StringIO()) as output:
            delivery.main([*args, *(["--record", str(self.record_path)] if args[0] == "verify" else [])])
        return json.loads(output.getvalue())

    def test_verify_and_real_cli_brief_and_ready_reservations(self):
        self.assertTrue(self.invoke("verify", "1")["passed"])
        self.assertEqual(self.invoke("brief", "P0.1")["id"], "P0.1")
        self.assertEqual(self.invoke("ready", "--running", "P0.1"), [])
        scripts = self.root / "scripts"
        scripts.mkdir()
        for name in ("delivery.py", "delivery_core.py"):
            shutil.copyfile(ROOT / "scripts" / name, scripts / name)
        result = subprocess.run([sys.executable, str(scripts / "delivery.py"), "brief", "P0.1"], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_failed_ci_missing_review_and_stale_base_block_verification(self):
        for failure in ("ci", "review", "base", "pagination", "graphql"):
            with self.subTest(failure=failure):
                saved = json.loads(json.dumps(self.state))
                if failure == "ci":
                    self.pr["commits"]["nodes"][0]["commit"]["statusCheckRollup"]["state"] = "FAILURE"
                elif failure == "review":
                    self.pr["reviews"]["nodes"] = []
                elif failure == "base":
                    self.state["data"]["repository"]["defaultBranchRef"]["target"]["oid"] = "c"*40
                elif failure == "pagination":
                    self.pr["files"]["pageInfo"]["hasNextPage"] = True
                else:
                    self.state["error"] = True
                with self.assertRaises(ValueError):
                    self.invoke("verify", "1")
                self.assertFalse(json.loads(self.state_path.read_text()).get("mutations"))
                self.state = saved
                self.pr = self.state["data"]["repository"]["pullRequest"]

    def test_export_requires_actual_merged_receipt_and_status(self):
        head = self.record["head"]
        self.pr.update(state="MERGED", mergedAt="2026-10-02T01:00:00Z", mergeCommit=dict(oid=head))
        self.state["data"]["repository"]["defaultBranchRef"]["target"]["oid"] = head
        self.git("--git-dir", str(self.origin), "update-ref", "refs/heads/main", head)
        self.pr["comments"]["nodes"] = [dict(author=dict(login="kartiksayani"), body="```ariadne-delivery\n"+json.dumps(self.record)+"\n```")]
        checks = self.pr["commits"]["nodes"][0]["commit"]["statusCheckRollup"]["contexts"]["nodes"]
        checks.append(dict(__typename="StatusContext", context="maintainer-spec-review", state="SUCCESS"))
        self.state["list"]["nodes"][0]["state"] = "MERGED"
        proof = self.invoke("export")["tasks"][0]
        self.assertEqual(proof["head_sha"], head)
        self.assertEqual(self.invoke("ready"), [])
        self.pr["comments"]["nodes"][0]["author"]["login"] = "outsider"
        with self.assertRaisesRegex(ValueError, "genuine"):
            self.invoke("export")
        checks[-1]["state"] = "FAILURE"
        with self.assertRaisesRegex(ValueError, "maintainer-spec-review"):
            self.invoke("export")

    def test_real_diff_and_unverified_prerequisite_block_verification(self):
        self.task["paths"] = ["src/other.rs"]
        self.pr["files"]["nodes"] = [dict(path="src/other.rs")]
        catalog = self.root / "docs/delivery/tasks.json"
        catalog.write_text(json.dumps(dict(tasks=[self.task])))
        with self.assertRaisesRegex(ValueError, "outside task ownership"):
            self.invoke("verify", "1")
        self.task["paths"] = ["src/**"]
        self.task["depends_on"] = ["P0.2"]
        dependency = dict(id="P0.2", paths=["other/**"], depends_on=[], spec=["docs/spec.md"])
        catalog.write_text(json.dumps(dict(tasks=[self.task, dependency])))
        with self.assertRaisesRegex(ValueError, "prerequisites"):
            self.invoke("verify", "1")
        self.assertFalse(json.loads(self.state_path.read_text()).get("mutations"))


if __name__ == "__main__":
    unittest.main()
