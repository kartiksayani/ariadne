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
GH = '''import json,os,sys,subprocess
from pathlib import Path
path=Path(os.environ['FAKE_GH_STATE']); s=json.loads(path.read_text()); args=sys.argv[1:]
if args[:2]==['api','graphql']:
 if s.get('error'): print(json.dumps({'errors':[{'message':'unavailable'}]})); sys.exit(0)
 if any('pullRequests(' in a for a in args): result={'repository':{'pullRequests':s['list']}}
 else:
  s['reads']=s.get('reads',0)+1; result=s['data']
  if s.get('stale') and s['reads']>=3: result['repository']['pullRequest']['headRefOid']='c'*40
else:
 endpoint=args[1]; body=json.loads(Path(args[args.index('--input')+1]).read_text()); s.setdefault('mutations',[]).append([endpoint,body])
 if endpoint.endswith('/comments'):
  s['data']['repository']['pullRequest']['comments']['nodes'].append({'body':body['body'],'author':{'login':'kartiksayani'}}); result={'html_url':'https://github.com/kartiksayani/ariadne/pull/1#issuecomment-1'}
 elif '/statuses/' in endpoint:
  s['data']['repository']['pullRequest']['commits']['nodes'][0]['commit']['statusCheckRollup']['contexts']['nodes'].append({'__typename':'StatusContext','context':'maintainer-spec-review','state':'SUCCESS'}); result={}
 else:
  p=s['data']['repository']['pullRequest']; base=s['data']['repository']['defaultBranchRef']['target']['oid']
  assert body=={'sha':p['headRefOid'],'merge_method':'squash'}
  merged=subprocess.run([os.environ['REAL_GIT'],'commit-tree',p['headRefOid']+'^{tree}','-p',base],input='Squash PR 1\\n',text=True,capture_output=True,check=True).stdout.strip()
  p.update(state='MERGED',mergedAt='2026-10-02T01:00:00Z',mergeCommit={'oid':merged}); result={'merged':True}
  s['data']['repository']['defaultBranchRef']['target']['oid']=merged
  subprocess.run([os.environ['REAL_GIT'],'push',os.environ['FIXTURE_ORIGIN'],merged+':refs/heads/main'],check=True,capture_output=True)
path.write_text(json.dumps(s)); print(json.dumps({'data':result} if args[:2]==['api','graphql'] else result))
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
        self.task = dict(id="P0.1", depends_on=[], paths=["src/**"], spec=["docs/spec.md"])
        self.catalog = dict(tasks=[self.task])
        (self.root / "docs/delivery").mkdir(parents=True)
        (self.root / "docs/delivery/tasks.json").write_text(json.dumps(self.catalog))
        self.git("add", ".")
        self.git("commit", "-qm", "base")
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
            delivery.main([*args, *(["--record", str(self.record_path)] if args[0] in {"verify", "merge"} else [])])
        return json.loads(output.getvalue())

    def test_verify_and_real_cli_brief_and_ready_reservations(self):
        self.assertTrue(self.invoke("verify", "1")["passed"])
        self.assertEqual(self.invoke("brief", "P0.1")["id"], "P0.1")
        self.assertEqual(self.invoke("ready", "--running", "P0.1"), [])
        scripts = self.root / "scripts"
        scripts.mkdir()
        for name in ("delivery.py", "delivery_core.py", "delivery_adrs.py"):
            shutil.copyfile(ROOT / "scripts" / name, scripts / name)
        result = subprocess.run([sys.executable, str(scripts / "delivery.py"), "brief", "P0.1"], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def architecture_fixture(self):
        first, second = "docs/adr/ADR-0001-first.md", "docs/adr/ADR-0002-second.md"
        content = ("# ADR-0001: Existing choice\n\nStatus: accepted\nSupersedes: none\nSuperseded by: none\n\n"
                   "## Context\nA gap.\n\n## Decision\nA choice.\n\n## Consequences\nA cost.\n\n"
                   "## Spec references\n[Spec](../spec.md)\n")
        (self.root / "docs/adr").mkdir()
        (self.root / first).write_text(content)
        (self.root / "docs/spec.md").write_text("Original behavior.\n")
        self.git("add", ".")
        self.git("commit", "-qm", "existing contract")
        base = self.git("rev-parse", "HEAD")
        self.git("--git-dir", str(self.origin), "fetch", "-q", str(self.root), "task")
        self.git("--git-dir", str(self.origin), "update-ref", "refs/heads/main", base)
        (self.root / first).write_text(content.replace("Status: accepted", "Status: deprecated").replace(
            "Superseded by: none", "Superseded by: [ADR-0002](ADR-0002-second.md)"))
        (self.root / second).write_text(content.replace("ADR-0001:", "ADR-0002:").replace(
            "Supersedes: none", "Supersedes: [ADR-0001](ADR-0001-first.md)"))
        (self.root / "docs/spec.md").write_text("Updated behavior.\n")
        self.git("add", ".")
        self.git("commit", "-qm", "decision and implementation")
        head = self.git("rev-parse", "HEAD")
        self.git("--git-dir", str(self.origin), "fetch", "-q", str(self.root), "task")
        self.git("--git-dir", str(self.origin), "update-ref", "refs/pull/1/head", head)
        self.state["data"]["repository"]["defaultBranchRef"]["target"]["oid"] = base
        self.pr["headRefOid"] = head
        self.pr["commits"]["nodes"][0]["commit"]["oid"] = head
        fetched = self.pr["reviews"]["nodes"][0]
        payload = dict(head=head, agent="independent", round=1, model="gpt-6.1-sol", effort="high", findings=[],
                       architecture_decisions=[first, second], spec_updates=["docs/spec.md"])
        fetched.update(commit=dict(oid=head), body="```ariadne-review\n" + json.dumps(payload) + "\n```")
        self.pr["files"]["nodes"] = [dict(path=path) for path in [first, second, "docs/spec.md"]]
        self.record.update(head=head, base=base, architecture_decisions=[first, second], spec_updates=["docs/spec.md"])
        self.record["reviews"][0]["head"] = head
        self.record["spec_review"]["sections"] = ["docs/spec.md", first, second]
        return first, second

    def test_committed_supersession_and_specs_are_verified_at_reviewed_head(self):
        first, second = self.architecture_fixture()
        self.assertTrue(self.invoke("verify", "1")["passed"])
        # An unstaged local rewrite is not the reviewed tree.
        (self.root / first).write_text("unreviewed local content\n")
        self.assertTrue(self.invoke("verify", "1")["passed"])
        self.record["architecture_decisions"].remove(first)
        with self.assertRaises(ValueError):
            self.invoke("merge", "1")
        self.assertFalse(json.loads(self.state_path.read_text()).get("mutations"))
        self.record["architecture_decisions"].insert(0, first)
        self.pr["files"]["nodes"] = [dict(path=second), dict(path="docs/spec.md")]
        # An omitted changed predecessor cannot pass the declaration/review gate.
        with self.assertRaises(ValueError):
            self.invoke("verify", "1")

    def test_merged_receipt_uses_original_decision_before_later_supersession(self):
        first, second = self.architecture_fixture()
        proof = self.invoke("merge", "1")
        self.state = json.loads(self.state_path.read_text())
        self.pr = self.state["data"]["repository"]["pullRequest"]
        self.git("fetch", "-q", str(self.origin), "main")
        self.git("checkout", "-qb", "later-main", proof["merged_commit"])
        third = "docs/adr/ADR-0003-third.md"
        content = (self.root / second).read_text()
        (self.root / second).write_text(content.replace("Status: accepted", "Status: deprecated").replace(
            "Superseded by: none", "Superseded by: [ADR-0003](ADR-0003-third.md)"))
        (self.root / third).write_text(content.replace("ADR-0002:", "ADR-0003:").replace(
            "[ADR-0001](ADR-0001-first.md)", "[ADR-0002](ADR-0002-second.md)"))
        self.git("add", ".")
        self.git("commit", "-qm", "later decision")
        later = self.git("rev-parse", "HEAD")
        self.git("--git-dir", str(self.origin), "fetch", "-q", str(self.root), "later-main")
        self.git("--git-dir", str(self.origin), "update-ref", "refs/heads/main", later)
        self.state["data"]["repository"]["defaultBranchRef"]["target"]["oid"] = later
        self.state["list"]["nodes"] = [dict(number=1, body=self.pr["body"], state="MERGED")]
        self.assertEqual(self.invoke("export")["tasks"], [proof])

    def test_rewritten_predecessor_in_actual_git_head_is_rejected(self):
        first, _ = self.architecture_fixture()
        path = self.root / first
        path.write_text(path.read_text().replace("A choice.", "A rewritten choice."))
        self.git("add", ".")
        self.git("commit", "-qm", "invalid rewrite")
        snapshot = dict(number=1, base=self.record["base"], head=self.git("rev-parse", "HEAD"))
        with self.assertRaisesRegex(ValueError, "preserve its prose"):
            delivery.architecture(snapshot, self.task, self.record)

    def test_failed_ci_missing_review_and_stale_base_never_merge(self):
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
                    self.invoke("merge", "1")
                self.assertFalse(json.loads(self.state_path.read_text()).get("mutations"))
                self.state = saved
                self.pr = self.state["data"]["repository"]["pullRequest"]

    def test_changed_head_after_receipt_stops_merge_and_success_exports_verified_proof(self):
        self.state["stale"] = True
        with self.assertRaises(ValueError):
            self.invoke("merge", "1")
        stored = json.loads(self.state_path.read_text())
        self.assertEqual(len(stored["mutations"]), 2)
        self.state.pop("stale")
        proof = self.invoke("merge", "1")
        self.assertEqual(proof["state"], "MERGED")
        self.state = json.loads(self.state_path.read_text())
        request = self.state["mutations"][-1]
        self.assertEqual(request, ["repos/kartiksayani/ariadne/pulls/1/merge",
                                   {"sha": self.record["head"], "merge_method": "squash"}])
        merged = self.state["data"]["repository"]["pullRequest"]["mergeCommit"]["oid"]
        self.assertNotEqual(merged, self.record["head"])
        self.assertEqual(self.git("rev-parse", merged + "^"), self.record["base"])
        self.assertEqual(self.git("rev-parse", merged + "^{tree}"),
                         self.git("rev-parse", self.record["head"] + "^{tree}"))
        self.state["list"]["nodes"] = [dict(number=1, body=self.pr["body"], state="MERGED")]
        self.assertEqual(self.invoke("export")["tasks"], [proof])
        self.assertEqual(self.invoke("ready"), [])

    def test_real_diff_and_unverified_prerequisite_block_verification(self):
        self.task["paths"] = ["src/other.rs"]
        self.pr["files"]["nodes"] = [dict(path="src/other.rs")]
        self.invoke("brief", "P0.1")
        with self.assertRaisesRegex(ValueError, "outside task ownership"):
            delivery.ancestor(delivery.snapshot(1), self.task, json.loads((self.root / "docs/delivery/tasks.json").read_text()))
        self.task["paths"] = ["src/**"]
        self.task["depends_on"] = ["P0.2"]
        dependency = dict(id="P0.2", paths=["other/**"], depends_on=[], spec=["docs/spec.md"])
        with self.assertRaisesRegex(ValueError, "prerequisites"):
            delivery.eligible({task["id"]: task for task in [self.task, dependency]}, self.task, self.catalog)
        self.assertFalse(json.loads(self.state_path.read_text()).get("mutations"))

    def test_stale_catalog_rejects_readiness_merge_and_later_fetch(self):
        self.git("checkout", "main")
        catalog = self.root / "docs/delivery/tasks.json"
        updated = json.loads(catalog.read_text())
        updated["tasks"][0].update(depends_on=["P0.2"], paths=["other/**"])
        updated["tasks"].append(dict(id="P0.2", depends_on=[], paths=["dependency/**"], spec=["docs/spec.md"]))
        catalog.write_text(json.dumps(updated))
        self.git("add", str(catalog))
        self.git("commit", "-qm", "new task constraints")
        self.git("push", str(self.origin), "main")
        self.git("checkout", "task")
        original = catalog.read_text()
        self.state["list"]["nodes"] = []
        for command in [("ready",), ("export",), ("verify", "1"), ("merge", "1")]:
            with self.subTest(command=command), self.assertRaisesRegex(ValueError, "refresh the maintainer checkout"):
                self.invoke(*command)
            self.assertFalse(json.loads(self.state_path.read_text()).get("mutations"))
        with self.assertRaisesRegex(ValueError, "refresh the maintainer checkout"):
            delivery.ancestor(delivery.snapshot(1), self.task, self.catalog)
        self.assertEqual(catalog.read_text(), original)


if __name__ == "__main__":
    unittest.main()
