#!/usr/bin/env python3
"""Personal macOS package installation. No provider or shell configuration writes."""
import argparse
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import plistlib
import re
import shutil
import selectors
import stat
import subprocess
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
LIMIT = 512 * 1024
BINARIES = ("ariadne", "ariadne-mcp")
RUST_VERSION = "1.98.1"
# Minimums, not pins (ADR-0072): Cargo.lock/package-lock.json fix the dependencies.
MIN_NODE = "22.23.2"
MIN_NPM = "10.9.8"
MIN_RUST = RUST_VERSION


class InstallError(ValueError):
    pass


class MissingPath(InstallError):
    """A directory Ariadne expected is not there; uninstall counts what it owned there as removed."""


def require(condition, message):
    if not condition:
        raise InstallError(message)


def component(value):
    require(isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", value),
            "Invalid package version.")
    return value


def safe_name(value):
    require(isinstance(value, str) and value and "\\" not in value, "Invalid inventory path.")
    path = PurePosixPath(value)
    require(not path.is_absolute() and all(p not in ("", ".", "..") for p in value.split("/")),
            "Inventory path escapes its package.")
    return path


def exists(path):
    return os.path.lexists(path)


def exists_at(parent_fd, name):
    try:
        os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        return True
    except FileNotFoundError:
        return False


def directory(path, create=False):
    if path.parent != path:
        directory(path.parent, create)
    if not exists(path):
        if not create:
            raise MissingPath(f"Missing directory: {path}")
        path.mkdir(mode=0o700)
    require(not path.is_symlink() and path.is_dir(), f"Unsafe directory: {path}")
    return path


@contextlib.contextmanager
def anchored_directory(path, parent_fd=None, create=False):
    """Walk each directory component without following any ancestor symlink."""
    if parent_fd is None:
        path = Path(path)
        require(path.is_absolute(), "Directory anchor requires an absolute path.")
        parts = path.parts[1:]
        fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    else:
        parts = safe_name(str(path)).parts
        fd = os.dup(parent_fd)
    try:
        for part in parts:
            try:
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            except FileNotFoundError:
                if not create:
                    raise MissingPath(f"Missing directory: {path}") from None
                os.mkdir(part, mode=0o700, dir_fd=fd)
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            except OSError as error:
                raise InstallError(f"Unsafe directory: {path}") from error
            os.close(fd)
            fd = child
        yield fd
    finally:
        os.close(fd)


@contextlib.contextmanager
def anchored_parent(root, relative):
    """Retain the package inode or walk its complete absolute no-follow chain."""
    parts = safe_name(relative).parts
    with contextlib.ExitStack() as stack:
        fd = os.dup(root) if isinstance(root, int) else stack.enter_context(anchored_directory(root))
        if isinstance(root, int):
            stack.callback(os.close, fd)
        for part in parts[:-1]:
            fd = stack.enter_context(anchored_directory(part, parent_fd=fd))
        yield fd, parts[-1]


def unchanged_identity(before, after):
    return (before.st_dev, before.st_ino, before.st_mode, before.st_size, before.st_mtime_ns) == (
        after.st_dev, after.st_ino, after.st_mode, after.st_size, after.st_mtime_ns)


def remove_owned(root, name, expected):
    with anchored_parent(root, name) as (parent, leaf):
        before = os.stat(leaf, dir_fd=parent, follow_symlinks=False)
        if expected["kind"] == "symlink":
            if not stat.S_ISLNK(before.st_mode) or os.readlink(leaf, dir_fd=parent) != expected["target"]:
                return False
        else:
            if not stat.S_ISREG(before.st_mode) or stat.S_IMODE(before.st_mode) != expected["mode"]:
                return False
            fd = os.open(leaf, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            with os.fdopen(fd, "rb") as source:
                if not unchanged_identity(before, os.fstat(source.fileno())):
                    return False
                digest = hashlib.sha256()
                for block in iter(lambda: source.read(1024 * 1024), b""):
                    digest.update(block)
            if digest.hexdigest() != expected["sha256"]:
                return False
        if not unchanged_identity(before, os.stat(leaf, dir_fd=parent, follow_symlinks=False)):
            return False
        os.unlink(leaf, dir_fd=parent)
        return True


def remove_owned_directory(root, name, mode, identity=None):
    with anchored_parent(root, name) as (parent, leaf):
        info = os.stat(leaf, dir_fd=parent, follow_symlinks=False)
        if not stat.S_ISDIR(info.st_mode) or stat.S_IMODE(info.st_mode) != mode:
            return False
        if identity is not None and (info.st_dev, info.st_ino) != identity:
            return False
        os.rmdir(leaf, dir_fd=parent)
        return True


def encode(value):
    return (json.dumps(value, sort_keys=True, indent=2, ensure_ascii=True) + "\n").encode()


def json_read(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as source:
        info = os.fstat(source.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_size <= LIMIT,
                f"Not a bounded regular descriptor: {path}")
        content = source.read(LIMIT + 1)
        require(len(content) <= LIMIT, "Descriptor exceeds its size limit.")
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, "Duplicate descriptor field.")
            result[key] = value
        return result
    return json.loads(content, object_pairs_hook=unique)


def record(path, root):
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode):
        target = os.readlink(path)
        require(not Path(target).is_absolute() and path.resolve().is_relative_to(root.resolve()),
                f"Package symlink escapes its application: {path}")
        return {"kind": "symlink", "target": target}
    require(stat.S_ISREG(info.st_mode), f"Nonregular package file: {path}")
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return {"kind": "file", "sha256": digest.hexdigest(), "mode": stat.S_IMODE(info.st_mode)}


def inventory(root):
    result = {}
    def visit(path):
        for child in sorted(path.iterdir()):
            if child.is_dir() and not child.is_symlink():
                visit(child)
            else:
                result[str(child.relative_to(root))] = record(child, root / "Ariadne.app")
    visit(root)
    result.pop("install.json", None)
    return result


SKILL_LINK = ".agents/skills/ariadne"
INTEGRATION_ROOTS = ("rules", "claude-mod", "codex-skills")


APP_PATH = "Applications/Ariadne.app"
# ADR-0062 layout (inventory_version 1): a symlink through `current`. Finder, Spotlight and
# Launchpad ignore it (ADR-0080), so it is only recognised to migrate or uninstall it.
LEGACY_APP_TARGET = "../.local/share/ariadne/current/Ariadne.app"


def app_inventory(app):
    """Inventory of an app copy, keyed like the `Ariadne.app/` subset of a package inventory."""
    result = {}
    def visit(path):
        for child in sorted(path.iterdir()):
            if child.is_dir() and not child.is_symlink():
                visit(child)
            else:
                result[f"Ariadne.app/{child.relative_to(app)}"] = record(child, app)
    visit(app)
    return result


def bundle_files(files):
    return {name: item for name, item in files.items() if name.startswith("Ariadne.app/")}


def receipts(root, home, versions_fd):
    """Every valid package receipt; unverifiable versions are skipped, never trusted."""
    found = []
    for name in sorted(os.listdir(versions_fd)):
        if name.startswith("."):
            continue
        try:
            found.append(descriptor(root / "versions" / name, home, partial=True))
        except (InstallError, OSError, ValueError):
            continue
    return found


def app_state(home, known):
    """Classify ~/Applications/Ariadne.app: absent, link (old layout), copy (ours) or None (not provably ours)."""
    path = home / APP_PATH
    if not exists(path):
        return "absent"
    if path.is_symlink():
        owned = os.readlink(path) == LEGACY_APP_TARGET and any(
            item["owned_links"].get(APP_PATH) == LEGACY_APP_TARGET for item in known)
        return "link" if owned else None
    if not path.is_dir():
        return None
    try:
        seen = app_inventory(path)
    except (InstallError, OSError):
        return None
    # Receipts of inventory_version 1 predate owned_app; the bytes are the proof for them.
    claims = (item for item in known if item.get("owned_app", True))
    return "copy" if any(bundle_files(item["owned_files"]) == seen for item in claims) else None


def discard(parent_fd, name):
    """Remove a path this run created inside an anchored directory, without following symlinks."""
    if not exists_at(parent_fd, name):
        return
    if stat.S_ISDIR(os.stat(name, dir_fd=parent_fd, follow_symlinks=False).st_mode):
        shutil.rmtree(name, dir_fd=parent_fd)
    else:
        os.unlink(name, dir_fd=parent_fd)


def place_app(home, final, state):
    """Copy the versioned bundle to ~/Applications/Ariadne.app, replacing an owned old one."""
    apps = directory(home / "Applications", True)
    stage = f".Ariadne.app.stage-{uuid.uuid4()}"
    old = f".Ariadne.app.old-{uuid.uuid4()}"
    with anchored_directory(apps) as apps_fd:
        try:
            shutil.copytree(final / "Ariadne.app", apps / stage, symlinks=True)
            if state != "absent":
                os.rename("Ariadne.app", old, src_dir_fd=apps_fd, dst_dir_fd=apps_fd)
            try:
                os.rename(stage, "Ariadne.app", src_dir_fd=apps_fd, dst_dir_fd=apps_fd)
            except BaseException:
                if exists_at(apps_fd, old):
                    os.rename(old, "Ariadne.app", src_dir_fd=apps_fd, dst_dir_fd=apps_fd)
                raise
        finally:
            discard(apps_fd, stage)
            discard(apps_fd, old)


def remove_app_copy(home, known):
    """Uninstall the app copy when its bytes are proven ours; otherwise leave it and say so."""
    path = home / APP_PATH
    if not exists(path) or path.is_symlink():
        return
    if app_state(home, known) == "copy":
        with anchored_directory(home / "Applications") as apps_fd:
            shutil.rmtree("Ariadne.app", dir_fd=apps_fd)
    elif any(item.get("owned_app") for item in known):
        print(f"{path} was edited after install, so it was left in place. Delete it yourself if you no longer want it.",
              flush=True)


def links(home):
    return {
        **{f".local/bin/{name}": f"../share/ariadne/current/bin/{name}" for name in BINARIES},
        # Codex discovers personal skills in ~/.agents/skills/<name>/SKILL.md (ADR-0070).
        SKILL_LINK: "../../.local/share/ariadne/current/integrations/codex-skills/ariadne",
    }


def skill_link_conflict(home, before, target):
    """Return why the Codex skill link must be skipped, or None when it is ours or absent."""
    path = home / SKILL_LINK
    for parent in (home / ".agents", path.parent):
        if exists(parent) and (parent.is_symlink() or not parent.is_dir()):
            return f"{parent} is not a plain directory"
    if exists(path) and not (before and before[1]["owned_links"].get(SKILL_LINK) == target and
                             path.is_symlink() and os.readlink(path) == target):
        return f"{path} already exists and is not Ariadne's link"
    return None


def manifest(root, home, version, files, directories, owned_links, preflight):
    return {"schema_version": 1, "version": version,
            "app_path": str(home / APP_PATH), "inventory_version": 2, "owned_app": True,
            "owned_files": files, "owned_directories": directories,
            "owned_links": owned_links, "preflight": preflight}


def descriptor(root, home, partial=False):
    """Read and validate a receipt. With partial=True a package whose helper is gone is accepted:
    the integration inventory cannot be cross-checked then, but every removal still verifies
    its own recorded hash, so nothing unverifiable is ever deleted."""
    value = json_read(root / "install.json")
    keys = {"schema_version", "version", "app_path", "inventory_version",
            "owned_files", "owned_directories", "owned_links", "preflight"}
    require(isinstance(value, dict) and set(value) in (keys, keys | {"owned_app"}), "Unknown install inventory format.")
    # Version 1 (ADR-0062) linked the app through `current` and has no owned_app; version 2 owns a copy.
    require(type(value["schema_version"]) is int and value["schema_version"] == 1 and
            type(value["inventory_version"]) is int and
            (value["inventory_version"], "owned_app" in value) in ((1, False), (2, True)) and
            (value["inventory_version"] == 1 or type(value["owned_app"]) is bool),
            "Unsupported install inventory version.")
    allowed = links(home) if value["inventory_version"] == 2 else {**links(home), APP_PATH: LEGACY_APP_TARGET}
    require(component(value["version"]) == root.name and value["app_path"] == str(home / APP_PATH),
            "Descriptor package identity does not match its version directory.")
    require(isinstance(value["owned_files"], dict) and value["owned_files"], "Missing owned inventory.")
    for name, item in value["owned_files"].items():
        parts = safe_name(name).parts
        require(name in ("bin/ariadne", "bin/ariadne-mcp", "integrations/setup.lock") or
                (len(parts) > 2 and parts[:2] == ("Ariadne.app", "Contents")) or
                (len(parts) > 2 and parts[0] == "integrations" and parts[1] in INTEGRATION_ROOTS),
                f"Unknown owned package path: {name}")
        require(isinstance(item, dict), "Invalid inventory record.")
        if item.get("kind") == "file":
            require(set(item) == {"kind", "sha256", "mode"} and
                    isinstance(item["sha256"], str) and re.fullmatch(r"[a-f0-9]{64}", item["sha256"]) and
                    type(item["mode"]) is int and 0 <= item["mode"] <= 0o777,
                    "Invalid file ownership record.")
        else:
            require(item.get("kind") == "symlink" and set(item) == {"kind", "target"} and
                    parts[0] == "Ariadne.app" and isinstance(item["target"], str) and
                    not Path(item["target"]).is_absolute(), "Invalid owned symlink.")
    require(isinstance(value["owned_links"], dict) and
            all(name in allowed and allowed[name] == target for name, target in value["owned_links"].items()),
            "Unknown external link inventory.")
    require(encode(value) == (root / "install.json").read_bytes(), "Edited or noncanonical install descriptor.")
    require(isinstance(value["owned_directories"], dict), "Missing directory ownership inventory.")
    for name, mode in value["owned_directories"].items():
        parts = safe_name(name).parts
        require(type(mode) is int and mode == 0o700 and (name in ("bin", "Ariadne.app", "integrations") or
                (len(parts) >= 2 and parts[:2] == ("Ariadne.app", "Contents")) or
                (len(parts) >= 2 and parts[0] == "integrations" and parts[1] in INTEGRATION_ROOTS)),
                "Unknown owned directory.")
    # The canonical compiled inventory authorizes integration names. Check the
    # helper before executing its read-only exporter; edited/missing helpers
    # cannot establish ownership of the remaining package.
    helper = root / "bin/ariadne"
    if partial and not exists(helper):
        return value
    directory(helper.parent)
    require(not helper.is_symlink() and helper.is_file() and
            value["owned_files"].get("bin/ariadne", {}).get("mode") == 0o700 and
            record(helper, root / "Ariadne.app") == value["owned_files"]["bin/ariadne"],
            "Installed helper identity is unavailable; preserve the entire package.")
    bundle = resources(helper, helper)
    known_resources = {"integrations/" + name for name in bundle} | {"integrations/setup.lock"}
    require({name for name in value["owned_files"] if name.startswith("integrations/")} == known_resources,
            "Unknown integration inventory; preserve the entire package.")
    known_directories = {str(parent) for name in known_resources for parent in PurePosixPath(name).parents
                         if str(parent).startswith("integrations")}
    require({name for name in value["owned_directories"] if name.startswith("integrations")} == known_directories,
            "Unknown integration directory inventory.")
    return value


def current(root, home, partial=False):
    path = root / "current"
    if not exists(path):
        return None
    require(path.is_symlink(), "Existing current pointer is not a package symlink.")
    target = os.readlink(path)
    require(target.startswith("versions/") and len(PurePosixPath(target).parts) == 2,
            "Existing current pointer escapes the versions directory.")
    version = component(target.split("/")[1])
    selected = root / "versions" / version
    if partial and not exists(selected):
        return selected, None  # the version folder is already gone; only the pointer is left
    directory(selected)
    require(path.resolve() == selected, "Current pointer redirects outside its exact version.")
    return selected, descriptor(selected, home, partial=partial)


@contextlib.contextmanager
def locked(home):
    require(home.is_absolute() and home.is_dir() and not home.is_symlink(), "HOME must be a real absolute directory.")
    root = home / ".local/share/ariadne"
    with contextlib.ExitStack() as stack:
        home_fd = stack.enter_context(anchored_directory(home))
        root_fd = stack.enter_context(anchored_directory(".local/share/ariadne", parent_fd=home_fd, create=True))
        versions_fd = stack.enter_context(anchored_directory("versions", parent_fd=root_fd, create=True))
        fd = os.open("install.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=root_fd)
        stack.callback(os.close, fd)
        require(stat.S_ISREG(os.fstat(fd).st_mode), "Install coordination file is not regular.")
        require(os.fstat(fd).st_uid == os.getuid(), "Install coordination file belongs to another user.")
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise InstallError("Another install/uninstall owns the package lock; retry later.") from error
        yield root, home_fd, root_fd, versions_fd


def run(args, cwd=ROOT, env=None, capture=False):
    return subprocess.run([str(arg) for arg in args], cwd=cwd, env=env, check=True,
                          text=True, stdout=subprocess.PIPE if capture else None,
                          timeout=900 if not capture else 30).stdout


def at_least(label, text, pattern, minimum):
    found = re.match(pattern, text)
    need = tuple(int(part) for part in minimum.split("."))
    require(found and tuple(int(part) for part in found.groups()) >= need,
            f"Ariadne needs {label.split(' ')[0]} {minimum} or newer; found {text or 'nothing'}.")


def node_supported(text):
    """Accept the Node lines locked dependencies support: ^22.23.2 || ^24.15.0 || >=26."""
    found = re.match(r"v(\d+)\.(\d+)\.(\d+)", text)
    version = tuple(int(part) for part in found.groups()) if found else None
    ok = version is not None and (
        (version[0] == 22 and version >= (22, 23, 2))
        or (version[0] == 24 and version >= (24, 15, 0))
        or version[0] >= 26)
    require(ok, "Ariadne needs Node 22.23.2 or newer on the 22 line, 24.15.0 or newer on the 24 line, "
                f"or 26 and later; found {text or 'nothing'}.")


def rust_toolchain(env):
    """Pick an installed toolchain without ever downloading one.

    Prefer the checkout's pinned toolchain when it is already installed. Otherwise use
    the owner's own default, resolved outside this checkout so that rust-toolchain.toml
    (an exact channel that rustup would try to download) does not apply.
    """
    try:
        # `rustup run` without --install only selects an already installed toolchain.
        versions = [run(["rustup", "run", RUST_VERSION, tool, "--version"], capture=True, env=env).strip()
                    for tool in ("rustc", "cargo")]
        return RUST_VERSION, *versions
    except (OSError, subprocess.SubprocessError):
        pass
    try:
        name = run(["rustup", "show", "active-toolchain"], cwd=Path.home(), capture=True, env=env).split()[0]
        versions = [run(["rustup", "run", name, tool, "--version"], cwd=Path.home(), capture=True, env=env).strip()
                    for tool in ("rustc", "cargo")]
        return name, *versions
    except (OSError, IndexError, subprocess.SubprocessError) as error:
        raise InstallError(f"Ariadne needs Rust {MIN_RUST} or newer with rustc and cargo; install it with rustup "
                           "before retrying. No toolchain download was attempted.") from error


def host_facts():
    """Checks every install needs, whether it builds or uses a prebuilt package."""
    require(sys.version_info >= (3, 11), "Python 3.11 or newer is required.")
    require(platform.system() == "Darwin", "Personal install requires macOS.")
    os_version = platform.mac_ver()[0]
    require(os_version and int(os_version.split(".")[0]) >= 13, "macOS 13 or newer is required.")
    arch = platform.machine()
    require(arch in ("arm64", "x86_64"), "Only arm64 and x86_64 macOS are supported.")
    return {"os": "macOS", "os_version": os_version, "architecture": arch,
            "python": platform.python_version()}


def preflight():
    base = host_facts()
    env = {**os.environ, "RUSTUP_AUTO_INSTALL": "0"}
    env.pop("RUSTUP_TOOLCHAIN", None)
    observed = {name: run([name, "--version"], capture=True, env=env).strip() for name in ("node", "npm")}
    node_supported(observed["node"])
    at_least("npm", observed["npm"], r"(\d+)\.(\d+)\.(\d+)", MIN_NPM)
    toolchain, observed["rustc"], observed["cargo"] = rust_toolchain(env)
    at_least("Rust", observed["rustc"], r"rustc (\d+)\.(\d+)\.(\d+)", MIN_RUST)
    at_least("Rust (cargo)", observed["cargo"], r"cargo (\d+)\.(\d+)\.(\d+)", MIN_RUST)
    observed["rust_toolchain"] = toolchain
    observed["xcode"] = run(["xcode-select", "-p"], capture=True).strip()
    require(observed["xcode"], "Install/select Xcode command line tools explicitly.")
    run(["xcrun", "--sdk", "macosx", "--show-sdk-path"], capture=True)
    return {**base, **observed}


def build():
    facts = preflight()
    print(json.dumps({"preflight": facts}), flush=True)
    target = ROOT / "target/personal-install"
    env = dict(os.environ)
    for name in list(env):
        if re.match(r"^(ARIADNE_E2E_|CARGO_FEATURE_|CARGO_ENCODED_RUSTFLAGS$|RUSTFLAGS$|TAURI_CONFIG$|TAURI_WEBDRIVER_PORT$|WDIO_EMBEDDED_SERVER$|VITE_ARIADNE_E2E$)", name):
            del env[name]
    env.update(CARGO_TARGET_DIR=str(target), MACOSX_DEPLOYMENT_TARGET="13.0",
               RUSTUP_AUTO_INSTALL="0", RUSTUP_TOOLCHAIN=facts.get("rust_toolchain", RUST_VERSION))
    run(["npm", "ci", "--ignore-scripts", "--engine-strict"], env=env)
    for command in ("gen-contracts", "gen-rules", "gen-codex-wire"):
        arguments = ["cargo", "run", "--locked", "-p", "ariadne-xtask", "--", command]
        if command == "gen-codex-wire":
            arguments += ["--version", "0.160.0"]
        run([*arguments, "--check"], env=env)
    run(["cargo", "build", "--release", "--locked", "-p", "ariadne-cli", "-p", "ariadne-mcp"], env=env)
    run(["node", ROOT / "node_modules/@tauri-apps/cli/tauri.js", "build", "--ci", "--bundles", "app",
         "--", "--locked", "--no-default-features"], cwd=ROOT / "apps/desktop", env=env)
    return target / "release", facts


def resources(helper, final_helper):
    # Consume bounded stdout while the producer runs, with a deadline. A malformed
    # exporter cannot allocate unbounded memory or block an installation forever.
    with subprocess.Popen([str(helper), "package-resources", "--helper-path", str(final_helper)],
                          stdout=subprocess.PIPE, stderr=subprocess.DEVNULL) as child:
        output = bytearray()
        try:
            with selectors.DefaultSelector() as selected:
                selected.register(child.stdout, selectors.EVENT_READ)
                deadline = time.monotonic() + 30
                while selected.get_map():
                    require(time.monotonic() < deadline, "Package resource export timed out.")
                    for key, _ in selected.select(min(1, max(0, deadline - time.monotonic()))):
                        block = os.read(key.fd, min(65536, LIMIT + 1 - len(output)))
                        if not block:
                            selected.unregister(key.fileobj)
                            continue
                        output.extend(block)
                        require(len(output) <= LIMIT, "Package resources exceed their output limit.")
            require(child.wait(timeout=max(0.01, deadline - time.monotonic())) == 0, "Package resource export failed.")
        finally:
            if child.poll() is None:
                child.kill()
                child.wait()
    value = json.loads(output)
    require(isinstance(value, dict) and set(value) == {"schema_version", "version", "files"} and
            type(value["schema_version"]) is int and value["schema_version"] == 1 and
            value["version"] == final_helper.parent.parent.name and
            isinstance(value["files"], dict) and value["files"], "Invalid integration resource export.")
    for name, text in value["files"].items():
        path = safe_name(name)
        require(path.parts[0] in INTEGRATION_ROOTS and len(path.parts) > 1 and isinstance(text, str),
                "Unknown package resource path.")
    return value["files"]


def install(home, artifacts, facts, resource_loader=resources):
    with locked(home) as (root, home_fd, root_fd, versions_fd):
        before = current(root, home)
        require(not exists(root / ".current-next"), "Unexpected pointer staging path.")
        if exists(home / "Applications"):
            directory(home / "Applications")
        # The app copy is replaced only when a receipt proves we made it (ADR-0080).
        state = app_state(home, receipts(root, home, versions_fd) if exists(home / APP_PATH) else [])
        require(state is not None, f"Foreign or edited install path: {home / APP_PATH}")
        expected_links = links(home)
        owned_links = {}
        for name, target in expected_links.items():
            path = home / name
            if name.startswith(".local/bin/") and not exists(path.parent):
                continue
            if name == SKILL_LINK:
                conflict = skill_link_conflict(home, before, target)
                if conflict:
                    print(f"Skipped the Codex skill link: {conflict}. Codex will not see the Ariadne skill. "
                          f"Move that path aside and run make install again, or link {path} to "
                          f"{root / 'current/integrations/codex-skills/ariadne'} yourself.", flush=True)
                    continue
            if exists(path):
                require(before and before[1]["owned_links"].get(name) == target and
                        path.is_symlink() and os.readlink(path) == target, f"Foreign or edited install path: {path}")
            if exists(path.parent):
                directory(path.parent)
            owned_links[name] = target
        app = artifacts / "bundle/macos/Ariadne.app"
        directory(app)
        directory(app / "Contents")
        info = app / "Contents/Info.plist"
        require(not info.is_symlink() and info.is_file() and info.stat().st_size <= LIMIT,
                "App Info.plist is not a bounded regular file.")
        with info.open("rb") as source:
            version = component(plistlib.load(source)["CFBundleShortVersionString"])
        final = root / "versions" / version
        for name in BINARIES:
            binary = artifacts / name
            require(not binary.is_symlink() and binary.is_file() and os.access(binary, os.X_OK), f"Missing executable: {binary}")
            require(run([binary, "--version"], capture=True).strip() == f"{name} {version}", "App/helper versions differ.")
        bundle = resource_loader(artifacts / "ariadne", final / "bin/ariadne")
        if before:
            require(inventory(before[0]) == before[1]["owned_files"], "Installed package contains edits or foreign files; preserve it and inspect manually.")
        stage = root / "versions" / f".stage-{uuid.uuid4()}"
        os.mkdir(stage.name, mode=0o700, dir_fd=versions_fd)
        created_links = []
        published = False
        try:
            shutil.copytree(app, stage / "Ariadne.app", symlinks=True)
            (stage / "Ariadne.app").chmod(0o700)
            for path in (stage / "Ariadne.app").rglob("*"):
                if not path.is_symlink():
                    path.chmod(0o700 if path.is_dir() else (0o700 if path.stat().st_mode & 0o111 else 0o600))
            directory(stage / "bin", True)
            for name in BINARIES:
                shutil.copyfile(artifacts / name, stage / "bin" / name)
                (stage / "bin" / name).chmod(0o700)
            for name, text in bundle.items():
                path = stage / "integrations" / str(safe_name(name))
                directory(path.parent, True)
                path.write_text(text)
                path.chmod(0o600)
            # Doctor's parity read uses this stable coordination inode. Setup
            # owns a separate optional receipt only for resources it creates.
            (stage / "integrations/setup.lock").touch(mode=0o600)
            files = inventory(stage)
            directories = {str(path.relative_to(stage)): stat.S_IMODE(path.stat().st_mode)
                           for path in stage.rglob("*") if path.is_dir() and not path.is_symlink()}
            receipt = manifest(final, home, version, files, directories, owned_links, facts)
            (stage / "install.json").write_bytes(encode(receipt))
            (stage / "install.json").chmod(0o600)
            if exists(final):
                directory(final)
                existing = descriptor(final, home)
                if SKILL_LINK in owned_links and SKILL_LINK not in existing["owned_links"]:
                    # The receipt on disk cannot record a link it never owned; leave it uncreated.
                    del owned_links[SKILL_LINK]
                    print("Skipped the Codex skill link: the installed receipt for this version does not "
                          "record it, so it is neither created nor adopted. "
                          "Uninstall and install again to add it.", flush=True)
                # A link the receipt owns but this run skipped is left alone, as uninstall does.
                # A version-1 receipt also records the old app symlink; the app copy is handled separately.
                kept = {k: v for k, v in existing["owned_links"].items() if k not in (SKILL_LINK, APP_PATH)}
                require(existing["owned_files"] == files and inventory(final) == files and
                        existing["owned_directories"] == directories and
                        kept == {k: v for k, v in owned_links.items() if k != SKILL_LINK},
                        "Same-version package identity differs; use a new release version.")
                shutil.rmtree(stage.name, dir_fd=versions_fd)
            else:
                os.rename(stage.name, final.name, src_dir_fd=versions_fd, dst_dir_fd=versions_fd)
                published = True
            for name, target in owned_links.items():
                path = home / name
                directory(path.parent, True)
                if not exists(path):
                    with anchored_parent(home_fd, name) as (parent, leaf):
                        os.symlink(target, leaf, dir_fd=parent)
                    created_links.append(path)
            temporary = root / ".current-next"
            require(not exists(temporary), f"Unexpected pointer staging path: {temporary}")
            os.symlink(f"versions/{version}", ".current-next", dir_fd=root_fd)
            os.replace(".current-next", "current", src_dir_fd=root_fd, dst_dir_fd=root_fd)
            # After the pointer flip: a crash here leaves the old copy, and `app_path` still opens.
            if not (state == "copy" and app_inventory(home / APP_PATH) == bundle_files(files)):
                place_app(home, final, state)
        except BaseException:
            for path in reversed(created_links):
                if path.is_symlink() and os.readlink(path) == owned_links[str(path.relative_to(home))]:
                    remove_owned(home_fd, str(path.relative_to(home)), {"kind": "symlink", "target": owned_links[str(path.relative_to(home))]})
            temporary = root / ".current-next"
            if temporary.is_symlink() and os.readlink(temporary) == f"versions/{version}":
                remove_owned(root_fd, ".current-next", {"kind": "symlink", "target": f"versions/{version}"})
            # This directory was created by this attempt and remains unpublished.
            if published and not (root / "current").resolve() == final:
                if inventory(final) == files:
                    shutil.rmtree(final.name, dir_fd=versions_fd)
            raise
        finally:
            if exists_at(versions_fd, stage.name):
                shutil.rmtree(stage.name, dir_fd=versions_fd)
        print(f"Installed Ariadne {version}: {home / APP_PATH}\nHelpers: {final / 'bin'}", flush=True)
        if not exists(home / ".local/bin"):
            print(f"PATH directory is absent. Add {root / 'current/bin'} to PATH explicitly; shell startup files were not edited.")
        return final


PACKAGE_KEYS = ("os", "os_version", "architecture", "python", "app_version", "source_sha", "built_at")


def app_version(artifacts):
    info = artifacts / "bundle/macos/Ariadne.app/Contents/Info.plist"
    require(not info.is_symlink() and info.is_file() and info.stat().st_size <= LIMIT,
            "App Info.plist is not a bounded regular file.")
    with info.open("rb") as source:
        return component(plistlib.load(source)["CFBundleShortVersionString"])


def assemble(artifacts, facts, dist, source_sha, built_at):
    """Turn a finished build into dist/ariadne-<version>-macos-<arch>.tar.gz."""
    version = app_version(artifacts)
    name = f"ariadne-{version}"
    stage = dist / name
    dist.mkdir(exist_ok=True)
    if exists(stage):
        shutil.rmtree(stage)
    (stage / "bundle/macos").mkdir(parents=True)
    shutil.copytree(artifacts / "bundle/macos/Ariadne.app", stage / "bundle/macos/Ariadne.app", symlinks=True)
    for binary in BINARIES:
        shutil.copyfile(artifacts / binary, stage / binary)
        (stage / binary).chmod(0o755)
    shutil.copyfile(Path(__file__).resolve(), stage / "install.py")
    shutil.copyfile(Path(__file__).resolve().parent / "install.sh", stage / "install.sh")
    (stage / "install.py").chmod(0o644)
    (stage / "install.sh").chmod(0o755)
    (stage / "package.json").write_bytes(encode({**facts, "app_version": version,
                                                 "source_sha": source_sha, "built_at": built_at}))
    tarball = dist / f"{name}-macos-{facts['architecture']}.tar.gz"
    if exists(tarball):
        tarball.unlink()
    # tar keeps symlinks and permissions; COPYFILE_DISABLE stops macOS adding ._ metadata files.
    run(["tar", "-czf", tarball.name, name], cwd=dist, env={**os.environ, "COPYFILE_DISABLE": "1"})
    shutil.rmtree(stage)
    return tarball


def package():
    artifacts, facts = build()
    sha = run(["git", "rev-parse", "HEAD"], capture=True).strip()
    built_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    tarball = assemble(artifacts, facts, ROOT / "dist", sha, built_at)
    print(f"Package: {tarball}", flush=True)
    return tarball


def install_package(home, package_dir):
    """Install a prebuilt package directory; it is read-only input and nothing is built."""
    package_dir = Path(package_dir).resolve()
    facts = host_facts()
    for name in ("install.py", "install.sh", "package.json", "ariadne", "ariadne-mcp"):
        path = package_dir / name
        require(not path.is_symlink() and path.is_file(), f"Package is incomplete; missing {name}.")
    require(not (package_dir / "bundle/macos/Ariadne.app").is_symlink() and
            (package_dir / "bundle/macos/Ariadne.app").is_dir(), "Package is incomplete; missing Ariadne.app.")
    try:
        built = json_read(package_dir / "package.json")
    except (OSError, ValueError) as error:
        raise InstallError(f"Package description package.json is unreadable: {error}") from error
    require(isinstance(built, dict) and set(built) >= set(PACKAGE_KEYS) and
            all(isinstance(built[key], str) and built[key] for key in PACKAGE_KEYS),
            "Package description package.json is malformed.")
    require(all(len(built[key]) <= 200 for key in PACKAGE_KEYS),
            "Package description package.json has a value longer than 200 characters.")
    built = {key: built[key] for key in PACKAGE_KEYS}
    require(built["architecture"] == facts["architecture"],
            f"This package is for {built['architecture']} Macs; this Mac is {facts['architecture']}.")
    require(built["app_version"] == app_version(package_dir), "Package description does not match its app.")
    replace_existing(home, built["app_version"])
    return install(home, package_dir, {**facts, "built": built})


def uninstall(home, announce=True):
    root_path = home / ".local/share/ariadne"
    if not exists(root_path):
        if announce:
            print("No personal Ariadne package installed.")
        return []
    retained = []
    with locked(home) as (root, home_fd, root_fd, versions_fd):
        selected = current(root, home, partial=True)
        packages = []
        # Validate every receipt before removing anything; unknown versions are retained.
        with contextlib.ExitStack() as anchors:
            for name in sorted(os.listdir(versions_fd)):
                child = root / "versions" / name
                try:
                    package_fd = anchors.enter_context(anchored_directory(name, parent_fd=versions_fd))
                    packages.append((child, descriptor(child, home, partial=True), package_fd))
                except (InstallError, OSError, ValueError):
                    retained.append(str(child))
            _uninstall_anchored(home, root, home_fd, root_fd, versions_fd, packages, selected, retained)
    for path in sorted(set(retained)):
        print(f"Retained edited, foreign or unverifiable path: {path}")
    if announce:
        print("Personal package uninstall finished. Project history and host configuration were preserved.")
    return retained


def replace_existing(home, version):
    """Remove a same-version install (complete or partial) that Ariadne owns, so a fresh one can follow."""
    final = home / ".local/share/ariadne/versions" / component(version)
    if not exists(final):
        return
    print(f"Replacing the Ariadne {version} already installed (your projects and history are kept).", flush=True)
    stop = (f"The Ariadne {version} already installed could not be replaced safely, because it holds files "
            f"Ariadne did not create or that were changed. Move the folder {final} somewhere else, "
            "then run ./install.sh again.")
    try:
        uninstall(home, announce=False)
    except (InstallError, OSError, ValueError) as error:
        raise InstallError(f"{stop} ({error})") from error
    require(not exists(final), stop)


def _uninstall_anchored(home, root, home_fd, root_fd, versions_fd, packages, selected, retained):
    try:
        remove_app_copy(home, [receipt for _, receipt, _ in packages])
    except (InstallError, OSError):
        retained.append(str(home / APP_PATH))
    for package, receipt, package_fd in packages:
        for name, expected in receipt["owned_files"].items():
            try:
                if not remove_owned(package_fd, name, expected):
                    retained.append(str(package / name))
            except (FileNotFoundError, MissingPath):
                pass  # already gone, so it counts as removed
            except (InstallError, OSError):
                retained.append(str(package / name))
        for name, target in receipt["owned_links"].items():
            path = home / name
            if name == APP_PATH and not path.is_symlink():
                continue  # a real app copy is settled by remove_app_copy
            if exists(path):
                if path.is_symlink() and os.readlink(path) == target:
                    if not remove_owned(home_fd, name, {"kind": "symlink", "target": target}):
                        retained.append(str(path))
                else:
                    retained.append(str(path))
        # Foreign files and nonempty directories survive. Keep descriptor for retained files.
        for name in sorted(receipt["owned_directories"], key=lambda p: len(PurePosixPath(p).parts), reverse=True):
            with contextlib.suppress(OSError, MissingPath):
                remove_owned_directory(package_fd, name, receipt["owned_directories"][name])
        if os.listdir(package_fd) == ["install.json"]:
            expected = {"kind": "file", "mode": 0o600,
                        "sha256": hashlib.sha256(encode(receipt)).hexdigest()}
            if remove_owned(package_fd, "install.json", expected):
                info = os.fstat(package_fd)
                if not remove_owned_directory(versions_fd, package.name, 0o700, (info.st_dev, info.st_ino)):
                    retained.append(str(package))
            else:
                retained.append(str(package))
        else:
            retained.append(str(package))
    if selected and not exists_at(versions_fd, selected[0].name):
        if not remove_owned(root_fd, "current", {"kind": "symlink", "target": f"versions/{selected[0].name}"}):
            retained.append(str(root / "current"))

def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("install", "uninstall", "package"))
    parser.add_argument("--package", type=Path, help="install from a prebuilt package directory instead of building")
    args = parser.parse_args(argv)
    if args.action == "package":
        require(args.package is None, "--package applies to install only.")
        package()
        return
    require(args.package is None or args.action == "install", "--package applies to install only.")
    home = Path(os.environ.get("HOME", ""))
    require(home.is_absolute(), "An absolute HOME is required.")
    if args.action == "uninstall":
        uninstall(home)
    elif args.package is not None:
        installed = install_package(home, args.package)
        run([installed / "bin/ariadne", "doctor"])
    else:
        artifacts, facts = build()
        replace_existing(home, app_version(artifacts))
        installed = install(home, artifacts, facts)
        run([installed / "bin/ariadne", "doctor"])


if __name__ == "__main__":
    try:
        main()
    except (InstallError, OSError, ValueError, subprocess.SubprocessError) as error:
        print(f"Personal package action stopped: {error}", file=sys.stderr)
        sys.exit(1)
