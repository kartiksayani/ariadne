"""Unit and orchestration tests for fail-closed commit gates."""
import contextlib
import hashlib
import importlib.util
import io
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("check_commit", ROOT / "scripts/check-commit.py")
commit = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(commit)


def report(root, name, source, hits):
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"SF:{source}\n" + "".join(
        f"DA:{number},{count}\n" for number, count in enumerate(hits, 1)
    ) + "end_of_record\n")
    return path


class CoverageTests(unittest.TestCase):
    def boundary(self, root, contents="// Package boundary.\n\n"):
        path = root / "crates/core/src/lib.rs"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.parent.parent.joinpath("Cargo.toml").write_text('[package]\nname = "core"\n')
        path.write_text(contents)
        return {"path": str(path.relative_to(root)), "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                "reason": "comment-only-rust-package-boundary"}

    def test_verified_boundaries_need_zero_records_without_changing_counts(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            entry = self.boundary(root)
            source = root / "crates/core/src/executable.rs"
            source.write_text("fn run() {}\n")
            rust = report(root, "rust.lcov", str(source.relative_to(root)), [1])
            config = {"non_executable_sources": [entry]}
            with self.assertRaisesRegex(ValueError, "omits application sources"):
                commit.coverage_counts([rust], root, config)
            commit.append_non_executable_records(rust, root, config)
            self.assertIn(f'SF:{entry["path"]}\nLF:0\nLH:0\nend_of_record\n', rust.read_text())
            self.assertEqual(commit.coverage_counts([rust], root, config), (1, 1))
            with self.assertRaisesRegex(ValueError, "Missing executable line data"):
                commit.coverage_counts([rust], root)

    def test_only_verified_boundaries_may_have_exact_zero_records(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            entry = self.boundary(root)
            rust = root / "rust.lcov"
            config = {"non_executable_sources": [entry]}
            for fields in ("LF:0\nLH:0\n", "", "LF:1\nLH:0\n", "LF:0\nLH:1\n",
                           "LF:0\nLH:0\nDA:1,1\n", "LF:0\nLH:0\nFN:1,fake\n"):
                rust.write_text(f'SF:{entry["path"]}\n{fields}end_of_record\n')
                with self.subTest(fields=fields), self.assertRaises(ValueError):
                    commit.coverage_counts([rust], root, config)
            with self.assertRaises(FileNotFoundError):
                commit.append_non_executable_records(root / "missing", root, config)

    def test_boundary_configuration_rejects_malformed_stale_and_executable_entries(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            entry = self.boundary(root)
            invalid = [None, "crates/core/src/lib.rs", {}, {**entry, "extra": True},
                       {**entry, "reason": "empty"}, {**entry, "path": "crates/core/lib.rs"},
                       {**entry, "path": "crates/core/src/../src/lib.rs"},
                       {**entry, "sha256": "bad"}, {**entry, "sha256": "a" * 64},
                       {**entry, "path": None}, {**entry, "path": "crates/missing/src/lib.rs"}]
            for value in invalid:
                with self.subTest(value=value), self.assertRaises(ValueError):
                    commit.coverage_policy(root, {"non_executable_sources": [value]})
            for config in ({"non_executable_sources": {}}, {"coverage_tooling": {}},
                           {"non_executable_sources": [entry, entry]}):
                with self.subTest(config=config), self.assertRaises(ValueError):
                    commit.coverage_policy(root, config)
            for contents in ("fn run() {}\n", "#![allow(dead_code)]\n", "/* comment */\n", "// comment\npub mod code;\n"):
                executable = self.boundary(root, contents)
                with self.subTest(contents=contents), self.assertRaisesRegex(ValueError, "contains Rust code"):
                    commit.coverage_policy(root, {"non_executable_sources": [executable]})
            entry = self.boundary(root, "")
            self.assertEqual(commit.coverage_policy(root, {"non_executable_sources": [entry]})[1], {entry["path"]})
            root.joinpath("crates/core/Cargo.toml").unlink()
            with self.assertRaisesRegex(ValueError, "package boundary"):
                commit.coverage_policy(root, {"non_executable_sources": [entry]})

    def test_hash_and_inventory_cannot_hide_new_executable_sources(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            entry = self.boundary(root)
            config = {"non_executable_sources": [entry]}
            root.joinpath(entry["path"]).write_text("fn new_behavior() {}\n")
            with self.assertRaisesRegex(ValueError, "hash changed"):
                commit.coverage_policy(root, config)
            self.boundary(root)
            source = root / "apps/main.ts"
            source.parent.mkdir()
            source.write_text("run();\n")
            rust = report(root, "report", "apps/main.ts", [1])
            commit.append_non_executable_records(rust, root, config)
            for extension in ("mjs", "cjs", "mts", "cts", "rs", "tsx"):
                added = root / f"integrations/mods/nested/future.{extension}"
                added.parent.mkdir(parents=True, exist_ok=True)
                added.write_text("new_behavior();\n")
                with self.subTest(extension=extension), self.assertRaisesRegex(ValueError, "omits application sources"):
                    commit.coverage_counts([rust], root, config)
                added.unlink()

    def test_tooling_allowlist_is_exact_and_does_not_disable_source_detection(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in commit.COVERAGE_TOOLING:
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("configure();\n")
            config = {"coverage_tooling": sorted(commit.COVERAGE_TOOLING)}
            self.assertTrue(commit.application_present(root, config))
            source = root / "apps/desktop/src/main.ts"
            source.parent.mkdir()
            source.write_text("run();\n")
            actual = report(root, "report", str(source.relative_to(root)), [1])
            self.assertEqual(commit.coverage_counts([actual], root, config), (1, 1))
            for names in (["apps/desktop/src/main.ts"], ["apps/**/*.ts"], [None], [{}],
                          ["apps/desktop/vite.config.ts"] * 2):
                with self.subTest(names=names), self.assertRaises(ValueError):
                    commit.coverage_policy(root, {"coverage_tooling": names})
            root.joinpath("apps/desktop/vite.config.ts").unlink()
            with self.assertRaises(ValueError):
                commit.coverage_policy(root, config)
            with self.assertRaisesRegex(ValueError, "omits application sources"):
                commit.coverage_counts([actual], root)

    def test_symlink_escape_and_zero_executable_evidence_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory, tempfile.TemporaryDirectory() as external:
            root = Path(directory)
            entry = self.boundary(root)
            config = {"non_executable_sources": [entry]}
            source = root / entry["path"]
            source.unlink()
            outside = Path(external) / "lib.rs"
            outside.write_text("// Outside boundary.\n")
            source.symlink_to(outside)
            with self.assertRaisesRegex(ValueError, "escapes repository"):
                commit.coverage_policy(root, config)
            source.unlink()
            self.boundary(root)
            link = root / "apps"
            link.symlink_to(Path(external), target_is_directory=True)
            with self.assertRaisesRegex(ValueError, "escapes repository"):
                commit.coverage_policy(root, config)
            outside.unlink()
            with self.assertRaisesRegex(ValueError, "escapes repository"):
                commit.coverage_policy(root, config)
            link.unlink()
            empty = root / "empty.lcov"
            empty.write_text("")
            commit.append_non_executable_records(empty, root, config)
            with self.assertRaisesRegex(ValueError, "Missing executable line data"):
                commit.coverage_counts([empty], root, config)
            executable = root / "apps/main.ts"
            executable.parent.mkdir()
            executable.write_text("run();\n")
            genuine = report(root, "genuine.lcov", "apps/main.ts", [1])
            for reports in ([genuine, empty], [empty, genuine]):
                with self.subTest(reports=reports), self.assertRaisesRegex(ValueError, "Missing executable line data"):
                    commit.coverage_counts(reports, root, config)

    def test_weighted_counts_include_zero_hits_and_merge_duplicate_lines(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first = report(root, "first", "src/a.rs", [1] * 8 + [0] * 2)
            second = report(root, "second", "src/b.ts", [0] * 90)
            duplicate = report(root, "duplicate", "src/a.rs", [0] * 10)
            self.assertEqual(commit.coverage_counts([first, second, duplicate]), (8, 100))

    def test_empty_malformed_and_impossible_reports_fail(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "report"
            for contents in ("", "SF:src/a.rs\nend_of_record\n", "DA:1,1\n",
                             "SF:src/a.rs\nDA:0,1\n", "SF:src/a.rs\nDA:1,-1\n"):
                path.write_text(contents)
                with self.subTest(contents=contents), self.assertRaises(ValueError):
                    commit.coverage_counts([path])
            with self.assertRaises(ValueError):
                commit.coverage_counts([])

    def test_real_sources_must_exist_fit_line_counts_and_all_be_covered(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "crates/a.rs"
            source.parent.mkdir()
            source.write_text("fn main() {}\n")
            (source.parent / "types.d.ts").write_text("declare const label: string;\n")
            self.assertEqual(commit.coverage_counts([report(root, "report", "crates/a.rs", [1])], root), (1, 1))
            generated = root / "crates/generated/fake.rs"
            generated.parent.mkdir()
            generated.write_text("generated source\n")
            for name, hits in (("crates/missing.rs", [1]), ("crates/a.rs", [1, 1]), ("../outside.rs", [1])):
                with self.subTest(source=name), self.assertRaises(ValueError):
                    commit.coverage_counts([report(root, "report", name, hits)], root)
            with self.assertRaisesRegex(ValueError, "not application code"):
                commit.coverage_counts([report(root, "report", "crates/generated/fake.rs", [1])], root)
            (source.parent / "untested.rs").write_text("fn untested() {}\n")
            with self.assertRaisesRegex(ValueError, "omits application sources"):
                commit.coverage_counts([report(root, "report", "crates/a.rs", [1])], root)


class DeclarationIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name).resolve()
        self.app = self.package("domain", "crates/domain", "domain")
        self.helper = self.package("ariadne-coverage-inventory", "tools/coverage-inventory", "helper")
        self.metadata = {"packages": [self.app, self.helper], "workspace_members": ["domain", "helper"],
                         "resolve": {"nodes": [{"id": "domain", "deps": []}, {"id": "helper", "deps": []}]}}
        self.install_parser(self.metadata)

    def install_parser(self, metadata):
        version, checksum = commit.SYN_IDENTITY
        package = {"id": "syn", "name": "syn", "version": version, "source": commit.REGISTRY,
                   "manifest_path": "/registry/syn/Cargo.toml", "dependencies": []}
        self.syn_lock = {"name": "syn", "version": version, "source": commit.REGISTRY, "checksum": checksum}
        helper = next(p for p in metadata["packages"] if p["name"] == "ariadne-coverage-inventory")
        helper["dependencies"].append({"name": "syn", "rename": None, "path": None, "req": "=" + version, "features": ["full"]})
        metadata["packages"].append(package)
        metadata["resolve"]["nodes"].extend([{"id": "syn", "deps": []}])
        next(n for n in metadata["resolve"]["nodes"] if n["id"] == helper["id"])["deps"].append({"name": "syn", "pkg": "syn"})
        (self.root / "Cargo.lock").write_text("[[package]]\n" + "".join(f'{k}={json.dumps(v)}\n' for k, v in self.syn_lock.items()))

    def package(self, name, folder, identity):
        path = self.root / folder
        (path / "src").mkdir(parents=True, exist_ok=True)
        (path / "Cargo.toml").write_text(f'[package]\nname="{name}"\nversion="0.1.0"\nedition="2021"\n')
        (path / "src/lib.rs").write_text("pub fn run() {}\n")
        return {"name": name, "id": identity, "manifest_path": str(path / "Cargo.toml"), "source": None,
                "version": "0.1.0", "dependencies": [],
                "targets": [{"kind": ["lib"], "src_path": str(path / "src/lib.rs")}]}

    def dependency(self, package, **extra):
        return {"name": package["name"], "rename": None, "path": str(Path(package["manifest_path"]).parent),
                "req": "=0.1.0", "optional": False, "kind": None, "target": None, **extra}

    def test_metadata_protects_exact_tool_identity_targets_and_builtin_bindings(self):
        self.assertEqual(commit.tool_packages(self.root, self.metadata), [self.helper])
        for field, value in (("name", "different"), ("source", commit.REGISTRY),
                             ("manifest_path", str(self.root / "crates/domain/Cargo.toml"))):
            original = self.helper[field]
            self.helper[field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                commit.tool_packages(self.root, self.metadata)
            self.helper[field] = original
        target = self.helper["targets"][0]
        for key, value in (("kind", ["proc-macro"]), ("kind", ["custom-build"]),
                           ("src_path", self.app["targets"][0]["src_path"])):
            original = target[key]
            target[key] = value
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                commit.tool_packages(self.root, self.metadata)
            target[key] = original
        duplicate = self.package(self.helper["name"], "crates/counterfeit", "counterfeit")
        self.metadata["packages"].append(duplicate)
        with self.assertRaisesRegex(ValueError, "identity"):
            commit.tool_packages(self.root, self.metadata)

    def test_inactive_renamed_target_dev_build_transitive_and_nested_tool_edges_fail(self):
        for options in ({"optional": True}, {"rename": "hidden"}, {"target": 'cfg(windows)'},
                        {"kind": "dev"}, {"kind": "build"}):
            self.app["dependencies"] = [self.dependency(self.helper, **options)]
            with self.subTest(options=options), self.assertRaisesRegex(ValueError, "reaches"):
                commit.tool_packages(self.root, self.metadata)
        middle = self.package("middle", "crates/middle", "middle")
        middle["dependencies"] = [self.dependency(self.helper, optional=True)]
        self.metadata["packages"].append(middle)
        self.app["dependencies"] = [self.dependency(middle)]
        with self.assertRaisesRegex(ValueError, "reaches"):
            commit.tool_packages(self.root, self.metadata)
        self.app["dependencies"] = [self.dependency(middle, path=None, rename="middle-alias")]
        self.metadata["resolve"]["nodes"][0]["deps"] = [{"name": "middle_alias", "pkg": "middle"}]
        with self.assertRaisesRegex(ValueError, "reaches"):
            commit.tool_packages(self.root, self.metadata)
        self.metadata["resolve"]["nodes"][0]["deps"] = []
        nested = self.package("nested", "tools/coverage-inventory/nested", "nested")
        self.metadata["packages"].append(nested)
        self.app["dependencies"] = [self.dependency(nested)]
        with self.assertRaisesRegex(ValueError, "reaches"):
            commit.tool_packages(self.root, self.metadata)
        self.app["dependencies"] = [self.dependency(middle, path=str(self.root / "unresolved"))]
        with self.assertRaisesRegex(ValueError, "Unresolved"):
            commit.tool_packages(self.root, self.metadata)
        self.app["dependencies"] = [{**self.dependency(self.helper), "path": None}]
        with self.assertRaisesRegex(ValueError, "Unresolved"):
            commit.tool_packages(self.root, self.metadata)
        self.app["dependencies"] = []
        self.helper["dependencies"].append(self.dependency(self.app))
        self.assertEqual(commit.tool_packages(self.root, self.metadata), [self.helper])

    def test_declaration_request_rejects_absent_helper_incomplete_results_and_symlink(self):
        source = self.root / "crates/domain/src/lib.rs"
        source.write_text("pub mod models;\n")
        names = {"crates/domain/src/lib.rs"}
        with mock.patch.object(commit, "cargo_metadata", return_value=self.metadata), mock.patch.object(
                commit, "run", return_value=mock.Mock(stdout=json.dumps({next(iter(names)): []}))) as run:
            commit.validate_declarations(self.root, names, names)
            request = json.loads(run.call_args.kwargs["input"])
            self.assertEqual(set(request["sources"]), names)
            self.assertEqual(request["roots"], [next(iter(names))])
            external = {"id": "adler", "name": "adler2", "manifest_path": "/registry/adler/Cargo.toml",
                        "dependencies": [{"name": "rustc-std-workspace-core", "rename": "core", "path": None}]}
            self.metadata["packages"].append(external)
            commit.validate_declarations(self.root, names, names)
            for binding in ("core", "std"):
                self.app["dependencies"] = [{"name": "replacement", "rename": binding, "path": None}]
                self.assertEqual(commit.tool_packages(self.root, self.metadata), [self.helper])
                with self.assertRaisesRegex(ValueError, "builtin"):
                    commit.validate_declarations(self.root, names, names)
            self.app["dependencies"] = []
            run.return_value.stdout = "{}"
            with self.assertRaisesRegex(ValueError, "incomplete"):
                commit.validate_declarations(self.root, names, names)
            self.metadata["workspace_members"].remove("helper")
            self.metadata["packages"].remove(self.helper)
            with self.assertRaisesRegex(ValueError, "requires"):
                commit.validate_declarations(self.root, names, names)
        target = self.root / "saved.rs"
        source.rename(target)
        source.symlink_to(target)
        with self.assertRaisesRegex(ValueError, "symlinks"):
            commit.validate_declarations(self.root, names, names)

    def test_pinned_macro_provider_checks_registry_checksum_alias_and_transitive_macro(self):
        version, checksum, macro, macro_checksum = commit.DERIVE_IDENTITIES["serde"]
        serde = {"id": "serde", "name": "serde", "version": version, "source": commit.REGISTRY,
                 "dependencies": [], "manifest_path": "/registry/serde/Cargo.toml"}
        derive = {**serde, "id": "derive", "name": macro}
        self.metadata["packages"].extend([serde, derive])
        self.metadata["resolve"]["nodes"].extend([
            {"id": "serde", "deps": [{"name": macro, "pkg": "derive"}]}, {"id": "derive", "deps": []}])
        self.metadata["resolve"]["nodes"][0]["deps"] = [{"name": "serde", "pkg": "serde"}]
        self.app["dependencies"] = [{"name": "serde", "rename": None, "path": None, "req": "=" + version}]
        lock = [{"name": name, "version": version, "source": commit.REGISTRY, "checksum": hash_value}
                for name, hash_value in (("serde", checksum), (macro, macro_checksum))]
        def write_lock():
            (self.root / "Cargo.lock").write_text("".join("[[package]]\n" + "".join(
                f'{key}={json.dumps(value)}\n' for key, value in package.items()) for package in [*lock, self.syn_lock]))
        write_lock()
        names = {"crates/domain/src/lib.rs"}
        with mock.patch.object(commit, "cargo_metadata", return_value=self.metadata), mock.patch.object(
                commit, "run", return_value=mock.Mock(stdout=json.dumps({next(iter(names)): ["serde"]}))) as run:
            commit.validate_declarations(self.root, names, names)
            for subject, key, value in ((serde, "source", None), (derive, "version", "0.0.0"),
                                        (self.app["dependencies"][0], "rename", "serde"),
                                        (self.app["dependencies"][0], "req", "^" + version),
                                        (lock[1], "checksum", "0" * 64)):
                original = subject[key]
                subject[key] = value
                write_lock()
                with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                    commit.validate_declarations(self.root, names, names)
                subject[key] = original
            write_lock()
            run.return_value.stdout = json.dumps({next(iter(names)): ["unknown"]})
            with self.assertRaisesRegex(ValueError, "unknown"):
                commit.validate_declarations(self.root, names, names)

    def test_parser_identity_cannot_be_replaced_by_local_alias_version_or_checksum(self):
        syn = next(p for p in self.metadata["packages"] if p["name"] == "syn")
        for subject, key, value in ((syn, "source", None), (syn, "version", "3.0.6"),
                                    (self.helper["dependencies"][0], "rename", "syn"),
                                    (self.helper["dependencies"][0], "features", [])):
            original = subject[key]
            subject[key] = value
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, "verified syn"):
                commit.tool_packages(self.root, self.metadata)
            subject[key] = original
        (self.root / "Cargo.lock").write_text('[[package]]\nname="syn"\nversion="2.0.119"\nsource=' + json.dumps(commit.REGISTRY) + '\nchecksum="bad"\n')
        with self.assertRaisesRegex(ValueError, "verified syn"):
            commit.tool_packages(self.root, self.metadata)

    def test_inactive_package_renamed_local_override_is_rejected_from_real_metadata(self):
        middle = self.root / "crates/middle"
        (middle / "src").mkdir(parents=True)
        (middle / "src/lib.rs").write_text("pub struct Middle;\n")
        (middle / "Cargo.toml").write_text('[package]\nname="middle"\nversion="0.1.0"\nedition="2021"\n[dependencies]\nserde={version="=1.0.228",optional=true}\n')
        app_manifest = Path(self.app["manifest_path"])
        app_manifest.write_text(app_manifest.read_text() + '[dependencies]\nmiddle={path="../middle"}\n')
        patch = self.root / "tools/coverage-inventory/patch-serde"
        (patch / "src").mkdir(parents=True)
        (patch / "src/lib.rs").write_text("pub struct Data;\n")
        (patch / "Cargo.toml").write_text('[package]\nname="serde"\nversion="1.0.228"\nedition="2021"\n')
        manifest = self.root / "Cargo.toml"
        manifest.write_text('[workspace]\nmembers=["crates/domain","tools/coverage-inventory"]\nexclude=["crates/middle","tools/coverage-inventory/patch-serde"]\nresolver="2"\n[patch.crates-io]\nrenamed={package="serde",path="tools/coverage-inventory/patch-serde"}\n')
        args = ["cargo"]
        subprocess.run([*args, "generate-lockfile", "--offline"], cwd=self.root, check=True, capture_output=True)
        result = subprocess.run([*args, "metadata", "--format-version=1", "--all-features", "--locked", "--offline"],
                                cwd=self.root, check=True, text=True, capture_output=True)
        metadata = json.loads(result.stdout)
        package = next(p for p in metadata["packages"] if p["name"] == "middle")
        self.assertTrue(package["dependencies"][0]["optional"])
        self.assertNotIn("path", package["dependencies"][0])
        node = next(n for n in metadata["resolve"]["nodes"] if n["id"] == package["id"])
        self.assertEqual(node["deps"], [])
        with self.assertRaisesRegex(ValueError, "override targets"):
            commit.tool_packages(self.root, metadata)
        manifest.write_text('[replace]\n"middle:0.1.0"={path="tools/coverage-inventory/patch-serde"}\n')
        with self.assertRaisesRegex(ValueError, "override targets"):
            commit.tool_packages(self.root, self.metadata)
        manifest.write_text('[patch.crates-io]\nother={path="crates/middle"}\n')
        with self.assertRaisesRegex(ValueError, "unsupported"):
            commit.tool_packages(self.root, self.metadata)

    def test_zero_append_is_idempotent_but_rejects_real_or_duplicate_classified_evidence(self):
        entry = CoverageTests().boundary(self.root)
        config = {"non_executable_sources": [entry]}
        path = report(self.root, "coverage/rust.lcov", "crates/domain/src/lib.rs", [1])
        commit.append_non_executable_records(path, self.root, config)
        previous = path.read_text()
        commit.append_non_executable_records(path, self.root, config)
        self.assertEqual(path.read_text(), previous)
        for evidence in (f'SF:{entry["path"]}\nDA:1,0\nend_of_record\n',
                         f'SF:{entry["path"]}\nLF:0\nLH:0\nend_of_record\n' * 2):
            path.write_text(evidence)
            with self.subTest(evidence=evidence), self.assertRaisesRegex(ValueError, "contradictory or duplicate"):
                commit.append_non_executable_records(path, self.root, config)
        path.write_text(previous + f'SF:{entry["path"]}\nLF:0\nLH:0\nend_of_record\n')
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            commit.coverage_counts([path], self.root, config)


class PhaseTests(unittest.TestCase):
    def test_phase_floor_and_scope_fail_closed(self):
        config = {"phase": "planning", "minimum_line_coverage": 80}
        commit.validate_phase(config, False)
        commit.validate_phase({**config, "phase": "application"}, True)
        for overrides, present in (({}, True), ({"phase": "preview"}, False),
                                   ({"minimum_line_coverage": 79}, False),
                                   ({"minimum_line_coverage": float("nan")}, False),
                                   ({"minimum_line_coverage": 101}, False),
                                   ({"production_roots": ["apps"]}, False),
                                   ({"application_reports": []}, False)):
            with self.subTest(overrides=overrides), self.assertRaises(ValueError):
                commit.validate_phase({**config, **overrides}, present)

    def test_detection_uses_canonical_roots_and_root_cargo_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "docs").mkdir()
            (root / "docs/sample.ts").touch()
            self.assertFalse(commit.application_present(root, {}))
            for folder, filename in (("apps", "main.tsx"), ("crates", "lib.rs"), ("integrations", "mod.mjs"), ("integrations", "mod.cjs"), ("integrations", "mod.mts")):
                path = root / folder / filename
                path.parent.mkdir(exist_ok=True)
                path.touch()
                self.assertTrue(commit.application_present(root, {"production_roots": []}))
                path.unlink()
            (root / "Cargo.toml").touch()
            self.assertTrue(commit.application_present(root, {}))


class OrchestrationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.config = {"phase": "planning", "minimum_line_coverage": 80}
        self.commands = []
        self.failure = None
        self.npm_version = "10.9.8"
        self.hits = [1] * 4 + [0]
        (self.root / ".venv-quality/bin").mkdir(parents=True)
        (self.root / ".venv-quality/bin/ruff").touch()
        patch = mock.patch.object(commit, "ROOT", self.root)
        patch.start()
        self.addCleanup(patch.stop)

    def run_tool(self, *args, capture=False):
        args = tuple(map(str, args))
        self.commands.append(args)
        if self.failure and self.failure in args:
            raise subprocess.CalledProcessError(1, args)
        if getattr(self, "tool_metadata", None) and "metadata" in args:
            return subprocess.CompletedProcess(args, 0, stdout=json.dumps(self.tool_metadata))
        if "llvm-cov" in args:
            objects = getattr(self, "coverage_objects", [])
            if "clean" in args:
                objects.clear()
            elif "report" in args:
                if hasattr(self, "coverage_objects"):
                    self.assertEqual(objects, ["current-workspace"])
                report(self.root, "coverage/tooling/ariadne-coverage-inventory.lcov",
                       "tools/coverage-inventory/src/lib.rs", self.tool_hits)
            else:
                objects.append("current-workspace")
                report(self.root, "coverage/rust.lcov", "crates/lib.rs", self.hits)
        if "test:coverage" in args:
            report(self.root, "coverage/web/lcov.info", "apps/main.ts", self.hits)
        return subprocess.CompletedProcess(args, 0, stdout=self.npm_version if args == ("npm", "--version") else "")

    def execute(self, args):
        (self.root / "quality-gates.json").write_text(json.dumps(self.config))
        with mock.patch.object(commit, "run", side_effect=self.run_tool), contextlib.redirect_stdout(io.StringIO()):
            commit.main(args)

    def test_staged_and_ci_modes_run_lint_fresh_coverage_and_functional_tests(self):
        for mode in ([], ["--ci"], ["--working-tree"]):
            self.commands = []
            self.execute(mode)
            flattened = " ".join(" ".join(command) for command in self.commands)
            self.assertIn("coverage run", flattened)
            self.assertIn("coverage report --fail-under=80", flattened)
            self.assertIn("node_modules/eslint/bin/eslint.js . --max-warnings=0", flattened)
            self.assertNotIn("npm run lint:planning", flattened)
            self.assertEqual("--staged" in flattened, not mode)
        for folder in ("docs/planning", "poc/claude-mods", "poc/codex-queue"):
            (self.root / folder).mkdir(parents=True)
        self.execute(["--ci"])
        flattened = " ".join(" ".join(command) for command in self.commands)
        for expected in ("validate-planning.py", "poc/claude-mods", "poc/codex-queue"):
            self.assertIn(expected, flattened)

    def test_missing_linter_and_tool_failures_cannot_pass(self):
        for failure in ("check", "node", "coverage"):
            self.failure = failure
            with self.subTest(failure=failure), self.assertRaises(subprocess.CalledProcessError):
                self.execute(["--ci"])
        self.failure = None
        (self.root / ".venv-quality/bin/ruff").unlink()
        with mock.patch.object(commit.shutil, "which", return_value=None), self.assertRaisesRegex(ValueError, "Ruff is required"):
            self.execute(["--ci"])

    def test_staged_gate_rejects_untested_working_tree(self):
        with mock.patch.object(commit, "run", return_value=mock.Mock(stdout="changed.py\n")):
            with self.assertRaisesRegex(ValueError, "match the index"):
                commit.require_staged_tree()

    def test_old_or_invalid_npm_blocks_application_commands(self):
        self.config["phase"] = "application"
        for version in ("6.14.8", "10.9.7", "", "config failed", "10.9.8-preview"):
            self.npm_version = version
            self.commands = []
            with self.subTest(version=version), self.assertRaisesRegex(ValueError, "require npm >=10.9.8"):
                self.execute(["--ci"])
            self.assertEqual(self.commands, [("npm", "--version")])

    def test_application_gates_enforce_e2e_and_fresh_eighty_percent_reports(self):
        self.config["phase"] = "application"
        for name in ("crates/lib.rs", "apps/main.ts"):
            path = self.root / name
            path.parent.mkdir()
            path.write_text("statement\n" * 5)
        for name in commit.APPLICATION_REPORTS:
            report(self.root, name, "fake.rs", [1])
        self.execute(["--ci"])
        self.assertIn(("npm", "run", "test:e2e"), self.commands)
        self.hits = [1, 0, 0, 0, 0]
        with self.assertRaisesRegex(ValueError, "below the configured minimum"):
            self.execute(["--ci"])
        self.failure = "test:e2e"
        with self.assertRaises(subprocess.CalledProcessError):
            self.execute(["--ci"])
        self.failure = None
        with mock.patch(__name__ + ".report"), self.assertRaises(FileNotFoundError):
            self.execute(["--ci"])

    def test_application_boundary_evidence_is_added_only_after_real_rust_report(self):
        entry = CoverageTests().boundary(self.root)
        self.config.update(phase="application", non_executable_sources=[entry],
                           coverage_tooling=["apps/desktop/vite.config.ts"])
        for name in ("crates/lib.rs", "apps/main.ts", "apps/desktop/vite.config.ts"):
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("statement\n" * 5)
        self.execute(["--ci"])
        self.assertIn("LF:0\nLH:0", self.root.joinpath("coverage/rust.lcov").read_text())
        flattened = " ".join(" ".join(command) for command in self.commands)
        for expected in ("cargo fmt", "cargo clippy", "npm run lint", "test:coverage", "test:e2e"):
            self.assertIn(expected, flattened)
        with mock.patch(__name__ + ".report"), self.assertRaises(FileNotFoundError):
            self.execute(["--ci"])

    def test_tools_are_tested_once_and_measured_independently_without_stale_or_foreign_evidence(self):
        self.config["phase"] = "application"
        for name in ("crates/lib.rs", "apps/main.ts"):
            path = self.root / name
            path.parent.mkdir()
            path.write_text("statement\n" * 5)
        (self.root / "Cargo.toml").touch()
        factory = DeclarationIntegrationTests()
        factory.root = self.root.resolve()
        helper = factory.package("ariadne-coverage-inventory", "tools/coverage-inventory", "exact-helper-pkgid")
        self.tool_metadata = {"packages": [helper], "workspace_members": [helper["id"]],
                              "resolve": {"nodes": [{"id": helper["id"], "deps": []}]}}
        factory.install_parser(self.tool_metadata)
        self.tool_hits = [1]
        self.coverage_objects = ["stale-excluded-helper"]
        self.execute(["--ci"])
        coverage = [args for args in self.commands if "llvm-cov" in args]
        cleanup = ("env", "CARGO_LLVM_COV_DENY_WARNINGS=1", "cargo", "llvm-cov", "clean",
                   "--workspace", "--locked", "--offline")
        self.assertEqual(len(coverage), 3)
        self.assertEqual(coverage[0], cleanup)
        self.assertEqual(self.coverage_objects, ["current-workspace"])
        self.assertIn("--workspace", coverage[1])
        self.assertIn("--exclude-from-report", coverage[1])
        self.assertNotIn("--exclude", coverage[1])
        self.assertIn("--package", coverage[2])
        self.assertIn("exact-helper-pkgid", coverage[2])
        self.assertNotIn("--all-features", coverage[2])
        self.assertNotIn("CARGO_LLVM_COV_DENY_WARNINGS=1", coverage[1] + coverage[2])
        self.commands.clear()
        self.failure = "clean"
        with self.assertRaises(subprocess.CalledProcessError):
            self.execute(["--ci"])
        self.assertEqual([args for args in self.commands if "llvm-cov" in args], [cleanup])
        self.assertFalse((self.root / "coverage/rust.lcov").exists())
        self.assertFalse((self.root / "coverage/tooling/ariadne-coverage-inventory.lcov").exists())
        self.failure = None
        self.tool_hits = [0]
        with self.assertRaisesRegex(ValueError, "Independent tooling coverage"):
            self.execute(["--ci"])
        self.tool_hits = [1]
        self.hits = [0] * 5
        with self.assertRaisesRegex(ValueError, "below the configured minimum"):
            self.execute(["--ci"])
        self.hits = [1] * 5
        omitted = self.root / "tools/coverage-inventory/src/untested.rs"
        omitted.write_text("pub fn omitted() {}\n")
        with self.assertRaisesRegex(ValueError, "omits application sources"):
            self.execute(["--ci"])
        omitted.unlink()
        with mock.patch(__name__ + ".report"), self.assertRaises(FileNotFoundError):
            self.execute(["--ci"])
        tool_report = report(self.root, "tool.lcov", "apps/main.ts", [1])
        with self.assertRaisesRegex(ValueError, "not application code"):
            commit.coverage_counts([tool_report], self.root,
                                   expected_sources={"tools/coverage-inventory/src/lib.rs"})

    def test_command_wrapper_keeps_arguments_and_propagates_failure(self):
        with mock.patch.object(commit.shutil, "which", return_value="rtk"), mock.patch.object(commit.subprocess, "run") as process:
            commit.run("tool", Path("file with spaces"), capture=True)
            self.assertEqual(process.call_args.args[0], ["rtk", "proxy", "tool", "file with spaces"])
            self.assertTrue(process.call_args.kwargs["check"])

    def test_cli_help_and_missing_config_exit_codes(self):
        script = self.root / "scripts/check-commit.py"
        script.parent.mkdir()
        script.write_text((ROOT / "scripts/check-commit.py").read_text())
        for args, status in ((["--help"], 0), (["--ci"], 1)):
            result = subprocess.run([commit.sys.executable, str(script), *args],
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, status, result.stderr)
            if status:
                self.assertIn("quality-gates.json", result.stderr)


if __name__ == "__main__":
    unittest.main()
