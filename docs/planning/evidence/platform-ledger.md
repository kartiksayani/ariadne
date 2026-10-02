# P0.1 platform and staged scaffold ledger

Status: **platform inspected and exact template staged; application not implemented**.
Observed 2026-10-03 on the owner's Mac, from `task/P0.1` based on
`da1916af75829b114948623115e29ccbc5eb5bde`.

This records [P0.1's bootstrap recipe](../BUILD_HANDOFF.md#mechanical-bootstrap-recipe-implementation-session)
and prepares [P0.2's application gates](../DEVELOPMENT_CHECKS.md#application-scaffold-obligations).
Only this ledger and toolchain pins enter the repository. No production source,
root Cargo manifest or application lockfile is introduced. The planning gate
remains active; production application coverage is **N/A**.

## Installed command outputs

All commands below exited 0. Full stdout/stderr, command arrays, timestamp and
working directory are saved in the staged `tool-versions.json`.

| Command (each prefixed with `rtk proxy`) | Observed output |
| --- | --- |
| `rustc --version` | `rustc 1.98.1 (48a229cea 2026-09-01)` |
| `cargo --version` | `cargo 1.98.1 (797e8a9bc 2026-08-05)` |
| `rustup show active-toolchain` | `1.98.1-aarch64-apple-darwin`, overridden by this worktree's `rust-toolchain.toml` |
| `rustup component list --installed` | `cargo`, `clippy`, `llvm-tools`, `rust-std`, `rustc`, `rustfmt`, all `aarch64-apple-darwin` |
| `cargo llvm-cov --version` | `cargo-llvm-cov 0.9.1` |
| `node --version` | `v22.23.2` |
| `npm --version` (ambient worker PATH) | `6.14.8` |
| `/opt/homebrew/opt/node@22/bin/npm --version` | `10.9.8` |
| `sw_vers` | `ProductName: macOS`; `ProductVersion: 26.7`; `BuildVersion: 25G229` |
| `uname -m` | `arm64` |
| `xcode-select -p` | `/Applications/Xcode.app/Contents/Developer` |
| `xcodebuild -version` | `Xcode 26.5`; `Build version 17F42` |
| `claude --version` | `2.1.287 (Claude Code)` |
| `codex --version` | `codex-cli 0.160.0` |
| `python3 --version` (ambient worker PATH) | `Python 3.9.6` |
| `/opt/homebrew/bin/python3.12 --version` | `Python 3.12.9` |
| `.venv-quality/bin/python --version` | `Python 3.12.9` |
| `macos-ui/appium-local --version` (retained tooling project) | `3.8.0` |

The retained project's installed `appium-mac2-driver/package.json` reports
`4.3.6`. It is outside the application dependency graph.

The worker's ambient npm resolves to `/usr/local/bin/npm`; Node resolves to
`/opt/homebrew/bin/node`. Other agent shells can resolve different executables.
All staging npm operations explicitly prepend `/opt/homebrew/opt/node@22/bin`
to their subprocess PATH and use npm 10.9.8. Quality checks use this worktree's
Python 3.12.9 venv. No global PATH, host settings or other worktree was changed.

`.node-version` pins `22.23.2`. `rust-toolchain.toml` pins `1.98.1`, minimal
profile, rustfmt, Clippy and llvm-tools-preview. The previously installed stable
alias reported the same compiler; the numbered toolchain was installed and
verified rather than leaving a floating `stable` pin:

```sh
rtk proxy rustup toolchain install 1.98.1 --profile minimal --component rustfmt --component clippy --component llvm-tools-preview
```

Initial deployment target: **macOS 13.0**, native **arm64**, as specified in
BUILD_HANDOFF. Execution evidence is on macOS 26.7 only. macOS 13, Intel and
universal distribution have not been tested or claimed supported by this ledger.

## Exact generator and pristine provenance

The prescribed `npm view create-tauri-app version` returned **4.7.4**.
The registry reports Node `>=10`; installed Node 22.23.2 satisfies it.
The official [create-tauri-app release](https://github.com/tauri-apps/create-tauri-app/releases/tag/create-tauri-app-v4.7.4)
resolves to source commit `dd7f131abca04be596ca38e1377dbceba4742148`.
The [official Tauri generator documentation](https://v2.tauri.app/start/create-project/)
describes this maintained React/TypeScript template.
Registry metadata and downloaded generator/npm arm64 native tarballs are retained;
both tarballs matched their published SHA-512 integrity values.

Staging parent (fresh UUID, mode 0700):
`/private/tmp/ariadne-scaffold-5eb94cd5-f8cc-489f-b1b4-70a322f605c8`.
Pristine project: `/private/tmp/ariadne-scaffold-5eb94cd5-f8cc-489f-b1b4-70a322f605c8/ariadne`.
A separate `resolved/` copy contains exact pins, lockfiles and frontend build
outputs. Nothing was installed into or edited in the pristine project.

The registry query and exact generation command ran with that parent as cwd.
`npm-global-empty.conf` was an empty file created in the staging parent; the user
configuration was `/dev/null`. Distinct empty paths avoid npm's double-loading
error when user and global config both name `/dev/null`. No credential/config
contents were read, printed or copied.

```sh
rtk proxy env PATH=/opt/homebrew/opt/node@22/bin:$PATH NPM_CONFIG_USERCONFIG=/dev/null NPM_CONFIG_GLOBALCONFIG=/private/tmp/ariadne-scaffold-5eb94cd5-f8cc-489f-b1b4-70a322f605c8/npm-global-empty.conf NPM_CONFIG_REGISTRY=https://registry.npmjs.org npm view create-tauri-app version engines dist --json --registry=https://registry.npmjs.org
rtk proxy env PATH=/opt/homebrew/opt/node@22/bin:$PATH NPM_CONFIG_USERCONFIG=/dev/null NPM_CONFIG_GLOBALCONFIG=/private/tmp/ariadne-scaffold-5eb94cd5-f8cc-489f-b1b4-70a322f605c8/npm-global-empty.conf NPM_CONFIG_REGISTRY=https://registry.npmjs.org npm exec --yes --package=create-tauri-app@4.7.4 -- create-tauri-app ariadne --manager npm --template react-ts --identifier com.ariadne.desktop --tauri-version 2 --yes
```

For reproduction, create a new `/private/tmp/ariadne-scaffold-<uuid>` parent,
create its empty global config, and replace the parent path in both commands.
The target `ariadne` must not exist; do not use `--force` or run in the repository.
The generator output, CLI help, registry responses and command array/cwd are saved
beside the pristine tree. No generator update or floating alias was executed.

Pins were selected at `2026-10-02T21:52:55.855017+00:00`; generation completed at
`2026-10-02T21:53:26.916605+00:00`. Registry tag queries were used only to select a
concrete release/version; every invoked generator and staged direct dependency
is explicitly versioned.

The pristine manifest has **38 files**. Its canonical bytes are UTF-8 lines
`<file SHA-256>  <relative POSIX path>\n`, sorted by relative path, with a final
newline. Hashing `pristine.sha256` gives:
`8f1d303b3e77da2e86fc79f877938acc1099f4f8662245b0cc768aee2a725ea6`.
This is a manifest hash, not a hash of a directory object. `pristine.tar.gz` is
also retained: sorted regular files only, PAX format, mode 0644, uid/gid/mtime 0,
empty owner names and gzip filename, gzip mtime 0.

### Pristine file inventory

| Relative path | Bytes | SHA-256 |
| --- | ---: | --- |
| `.gitignore` | 253 | `fe718e7babb14f3cbad2d97f08889b9ce5215ed3fe0e43b2b8cfbfb3b9b844e8` |
| `.vscode/extensions.json` | 80 | `8988c707a30230dcaa815dc690caab61f43c57b13fb42e2d632e06a794b58454` |
| `README.md` | 378 | `133b8004135538586c776297f7c816e81bcae8c4e4df18553c3c719579442f8c` |
| `index.html` | 376 | `15d08508752a498afcc492cb6ff81c21df7d1097fdb5b39d966692093a604ad3` |
| `package.json` | 565 | `dd1f3d49dd24cb217347fcaa2207228c340f01ed7eda2a7349f08aa377903093` |
| `public/tauri.svg` | 2599 | `e5d2738bbaa5543c4684001a558dc53165da9b636144827b28db1dcfacf81aa8` |
| `public/vite.svg` | 1497 | `4a748afd443918bb16591c834c401dae33e87861ab5dbad0811c3a3b4a9214fb` |
| `src/App.css` | 1739 | `eb5874b63446b353c05c5a204fbd3978b88d476d3a99f9df7386dc189282e00c` |
| `src/App.tsx` | 1437 | `e6dc63c35112639488b2bafe8963757956547a9ecca6e4b693a578d2c64fe76b` |
| `src/assets/react.svg` | 4126 | `35ef61ed53b323ae94a16a8ec659b3d0af3880698791133f23b084085ab1c2e5` |
| `src/main.tsx` | 229 | `bfcf131d8fb04a4dadcdd633c0bdbefea3f3a7af5bb35d34dc55588991887654` |
| `src/vite-env.d.ts` | 38 | `65996936fbb042915f7b74a200fcdde7e410f32a669b1ab9597cfaa4b0faddb5` |
| `src-tauri/.gitignore` | 166 | `88707cda7ba4226eda3ffa91d8284f1a0d12b827f06fb9bc48425cc0d4af04af` |
| `src-tauri/Cargo.toml` | 919 | `a6ea82a38b36a6c21cf976f0bd224bed2f71ee68cc01ea779149614635368c20` |
| `src-tauri/build.rs` | 39 | `487059eaf8a947b80f20a9aacac038a5047b2ad69d2401b827376c67d6fe847f` |
| `src-tauri/capabilities/default.json` | 220 | `50e6561a0c5480e8f19379bb0f745c4ac48b8114a7127e614ecec24640cd74c0` |
| `src-tauri/icons/128x128.png` | 1593 | `1f3689f6374b0553996fdc99743799216703835070145d7f0e6ec11e6280139e` |
| `src-tauri/icons/128x128@2x.png` | 2861 | `69194785eef4323955af73b0c03362ac0804db056c2424f9715076cabc0ed103` |
| `src-tauri/icons/32x32.png` | 567 | `d151f11e325f7502de0c739a2e51697aa569fd4701ae6e11fae1a3b4c7d5f157` |
| `src-tauri/icons/Square107x107Logo.png` | 1340 | `fd8658ff0e2c177ce0779d11fea1574e9d7d82a52a3a9197038f37b07fe24475` |
| `src-tauri/icons/Square142x142Logo.png` | 1691 | `c348fcf2d2f2f9714a41925184926f77f440676987d233ae1daf4fd94fda245f` |
| `src-tauri/icons/Square150x150Logo.png` | 1738 | `d46dc2bc568f911b9cb978de68b4a7e3ad458fbac15196597849c43c40f4b65a` |
| `src-tauri/icons/Square284x284Logo.png` | 3115 | `80d93a5257c89ea57023c30500c889b4df062430ffb0b4fed4ca4785d13e29ac` |
| `src-tauri/icons/Square30x30Logo.png` | 536 | `c3ce70e22ec2ed3ea2d0362a767d087e6cadb93ec71e80010649f892520175f4` |
| `src-tauri/icons/Square310x310Logo.png` | 3447 | `624dd93ddb1f0d69f2a4aa7af0b0646ae3ae6347cbb42dab56ef88dba7f38d07` |
| `src-tauri/icons/Square44x44Logo.png` | 777 | `f9eca6f00dba41cfecfedbc9a6f88014b4ee0f9dbf016e202c7ede09c60107ef` |
| `src-tauri/icons/Square71x71Logo.png` | 1020 | `66a6b51da8962a9472c9d29b1b08e3309561521bf7fbaac52b9f680df13ff487` |
| `src-tauri/icons/Square89x89Logo.png` | 1181 | `fe8da53273722bb6fd66e98bf6810e8a7db22aeff27c6c1a096d57ba556b9ef4` |
| `src-tauri/icons/StoreLogo.png` | 848 | `5412fce324344999aad82f6b69abcaa6c8792eac7b79a4b321aaaeacd0525eaf` |
| `src-tauri/icons/icon.icns` | 98451 | `3dc10493b7de48a61de58f768f8a5708d3a44a068c148cedf0502b9b9b71ba5d` |
| `src-tauri/icons/icon.ico` | 37710 | `e38ca88e1d5490f3dcbc3c3fa525f7fcb7b80fff3cb2f3a4eb1b2d018c0915c1` |
| `src-tauri/icons/icon.png` | 5664 | `b5d93c8ec365c08b11bd006e46a46e227c681d30bb295af3d017573bfc752a83` |
| `src-tauri/src/lib.rs` | 490 | `7aeca7a49daacfabd88bf754e198cb79dceaed067652c37c3daafbb5a5d0054a` |
| `src-tauri/src/main.rs` | 182 | `7e95f74735a095019e771a3e68e2154853b148c4ab3b49d8d4e120de5745a476` |
| `src-tauri/tauri.conf.json` | 692 | `210ccbd05243038af727a51cf63cea0367728a1f240ad8812410627a8dc8b7f7` |
| `tsconfig.json` | 589 | `65c82e3009d033dba271b9ce83a712bb4b934aeded98cb9d3e33472dd4d5f49c` |
| `tsconfig.node.json` | 213 | `9e2abb169ea87b7190613a1d4da57ca608463a453bd4231fa3aeee5e308370dd` |
| `vite.config.ts` | 859 | `7275dd58de5c8e3be5398a950713417049ba46289f7577f24568afd7cf4ce524` |

## Selected exact dependencies and resolved locks

The generator's original manifests contain ranges. Those original files remain
unchanged for provenance; the following exact versions were selected before
invocation and applied only to `resolved/`. P0.2 must integrate those pins into
its actual workspace and commit fresh Cargo/npm lockfiles there. The temporary
resolution proves availability and the frontend build, not the future workspace.
TypeScript stays at 6.0.3 to satisfy this generator's `~6.0.3` range; other
frontend selections satisfy the generated ranges.

| npm dependency | Exact pin |
| --- | --- |
| `react` | `19.3.0` |
| `react-dom` | `19.3.0` |
| `@types/react` | `19.3.0` |
| `@types/react-dom` | `19.3.0` |
| `@vitejs/plugin-react` | `6.1.1` |
| `vite` | `8.3.2` |
| `typescript` | `6.0.3` |
| `@tauri-apps/api` | `2.12.1` |
| `@tauri-apps/cli` | `2.12.1` |
| `@tauri-apps/plugin-opener` | `2.7.0` |
| `vitest` | `5.0.3` |
| `@vitest/coverage-v8` | `5.0.3` |
| `jsdom` | `30.1.1` |
| `@testing-library/react` | `16.3.3` |
| `@testing-library/user-event` | `14.6.7` |
| `@testing-library/jest-dom` | `7.0.1` |
| `@wdio/tauri-service` | `1.4.0` |
| `@wdio/tauri-plugin` | `1.4.0` |
| `@wdio/cli` | `9.30.1` |
| `@wdio/local-runner` | `9.30.1` |
| `@wdio/mocha-framework` | `9.30.1` |
| `@wdio/spec-reporter` | `9.30.1` |
| `@testing-library/dom` | `10.4.2` |
| `@types/node` | `22.19.15` |

| Cargo dependency | Exact requirement |
| --- | --- |
| `tauri` | `=2.12.1` |
| `tauri-build` | `=2.7.1` |
| `tauri-plugin-opener` | `=2.7.0` |
| `tauri-plugin-wdio` | `=1.4.0` |
| `tauri-plugin-wdio-webdriver` | `=1.4.0` |
| `serde` | `=1.0.228` |
| `serde_json` | `=1.0.145` |

The staged package manager is `npm@10.9.8`, with exact Node/npm engine values
`22.23.2`/`10.9.8`. Existing repository quality pins remain ESLint 10.11.0,
`@eslint/js` 10.0.1, Ruff 0.13.3 and coverage.py 7.10.6. Rust coverage uses the
installed cargo-llvm-cov 0.9.1.

The [Vite engine requirement](https://vite.dev/guide/) and package metadata for
Vite 8.3.2/plugin-react 6.1.1 require Node `^20.19.0 || >=22.12.0`.
Vitest 5.0.3 requires `^22.12.0 || ^24.0.0 || >=26.0.0`; jsdom 30.1.1 requires
`^22.22.2 || ^24.15.0 || >=26.0.0`. Node 22.23.2 satisfies these limits.
The staged engine-strict resolution and locked install passed for the entire
npm graph; no engine override was used. Cargo's Tauri, tauri-build and opener
metadata declare Rust 1.90; Rust 1.98.1 exceeds that floor. Both WDIO Rust
plugins are optional under `e2e`, absent from default features. The embedded
plugin requires Tauri >=2.10 within major 2; 2.12.1 satisfies it.

The staged npm lock has 657 package entries including its root; Cargo has
490 entries including the temporary app. npm's platform-specific locked install
installed 597 packages. Both locks are retained verbatim. The graph has top-level
`@tauri-apps/api` 2.12.1 and WDIO plugin's nested API 2.11.1, as required by
[ADR-0003](../../adr/ADR-0003-align-tauri-build-dependencies.md). WDIO service uses
webdriverio 9.30.1/native-types 2.5.0. No `--ignore-version-mismatches` was used.

From `resolved/`, with the same explicit npm environment as generation:

```sh
rtk proxy npm install --package-lock-only --ignore-scripts --engine-strict --no-audit --no-fund
rtk proxy npm ci --ignore-scripts --engine-strict --no-audit --no-fund
rtk proxy npm run build
rtk proxy cargo +1.98.1 generate-lockfile --manifest-path src-tauri/Cargo.toml
```

All four commands exited 0. `tsc && vite build` transformed 19 modules and built
in 340 ms. Logs are retained beside the pristine project. Locked npm installation
reported deprecated transitive inflight, whatwg-encoding and glob packages in
the prescribed tooling graph; successful installation is not a security review.
No native app was compiled or launched here, and no frontend coverage was claimed.

### Retained staging artifacts

All paths below are relative to the staging parent. Hashes make the exact local
handoff inspectable; temporary storage is not a remote artifact registry.

| Artifact | SHA-256 |
| --- | --- |
| `pristine.sha256` | `8f1d303b3e77da2e86fc79f877938acc1099f4f8662245b0cc768aee2a725ea6` |
| `pristine.tar.gz` | `4d47fe642a534a3178c7954581abd71972802961261d1096a2578b360b286df4` |
| `provenance.json` | `ea10a3dc61b31f2d208b513aee4249648145ebe2316ec3b2382a30afadea4815` |
| `tool-versions.json` | `c5f7fd4718b2dafb74c10448b403632857002a29a13520afc925743c2d0b0f63` |
| `selected-pins-before-generation.json` | `3247de22a6df8ad3977d04a0476214884bcc1f6f13b7f9d14ae1c8bddd0058d1` |
| `generator-registry.json` | `78236bdc01df2fca01aac726e33e812683d277ee56642d9f982b9c7b745a3927` |
| `create-tauri-app-4.7.4.tgz` | `9a63ab7b317f35d5a9162fff935909b36b000f3c568931e19eea383e1d159658` |
| `create-tauri-app-darwin-arm64-4.7.4.tgz` | `3dc7e55b1d0b40c042ab5ce505052b3ca5a6f286ebc1b968dbeae2a333581de1` |
| `resolved/package.json` | `82a57a5f9037b5761dd214057a6b8205d719131b4ef37e8dbe58e8f59537d00a` |
| `resolved/package-lock.json` | `f414a04a63dfe7a8107804b396f51184fd7677e4da5611db53ccd239e0ff2747` |
| `resolved/src-tauri/Cargo.toml` | `75341032c73501400f21c1d2279c600b54b378cf9652896516d3fa63d2e409dc` |
| `resolved/src-tauri/Cargo.lock` | `cfaa4d4dd8097cd322e301ba9e134d2761e1828230116a7c10e5b5069358c646` |

Additional retained evidence: `dependency-registry.json`, `crates-registry.json`,
`upstream-template-manifest.json`, `upstream-cargo-manifest.json`,
`generator-output.txt`, `generator-help.txt`, `npm-resolution.log`,
`cargo-resolution.log`, `frontend-install.log`, `frontend-build.log` and
`artifact-manifest.json`. These files contain tool/package evidence only.

## Host and native capability limits

Claude Code **2.1.287** and Codex CLI **0.160.0** match the previously proven
existing-session transport baselines. Compatibility stays an exact allowlist,
not a semver range. Other host versions require conformance fixtures and live
existing-session acceptance before widening it, following
[PROCESS_AND_PROTOCOLS section 6](../low-level/PROCESS_AND_PROTOCOLS.md#6-compatibility-and-permissions).
Codex daemon handshake/version equality has not been checked in P0.1. Version
commands do not establish a running conversation, permission state or live
transport health. No host was launched, resumed or sent a prompt; no private
transcript or credential was read. Live/billable acceptance remains at M7.

The retained native proof at
`/Users/kartik.sayani/Library/Caches/ariadne-devtools/native-preflight`
was read and all **34** manifest artifact hashes verified, with zero mismatches.
Its recorded WDIO 1/1 pass exercised real WebView actions, native invoke, Rust
file receipt, nonce rejection, independent PID/executable/ancestry, loopback
listener and cleanup on macOS 26.7 arm64. Its historical binary SHA-256 is
`198024c6c1f840373570fcb1e50374a8dbf11042dd56e74a93037b0765e15ea9`.
It proves the disposable prerequisite path, not production Ariadne or OS input.

The separate retained Mac2 proof at
`/Users/kartik.sayani/Library/Caches/ariadne-devtools/macos-ui`
records genuine XCTest click/typing/Command+A, native receipt and wrong-nonce
rejection, plus cleanup of run-owned processes/ports. These caches were preserved;
no duplicate native run or permission change was performed for this task.

P0.2 must execute the actual [embedded native recipe](../low-level/NATIVE_E2E.md#test-only-build-recipe)
with the locked application graph: e2e-only Cargo plugins and capability overlay,
conditional WDIO renderer bootstrap, loopback driver, private root, nonce/PID
witness, real form/invoke/disk receipt, rejected request and bounded cleanup.
Native process coverage needs a verified flush recipe before it can contribute
counters. Clean release builds must separately prove exclusion of the test
plugins, frontend module, capabilities and listener. Mac2 will supplement real
OS features as they exist. P0.1 does not prove tray/dialog/notification behavior,
release packaging, macOS 13 compatibility or application coverage.

## Repository validation and declarations

Baseline complete planning gate passed: **45 tests**, quality-helper coverage
**571/618 lines (92%)**, zero Ruff/ESLint violations, all planning checks passed.
The staged commit runs the same installed hook; final-head results belong in
its PR evidence. Documentation/toolchain pins add no application behavior and
need no placeholder application tests. The 80% application floor is unchanged.

`architecture_decisions: []`; `spec_updates: []`. Version resolution followed
the prescribed recipe and accepted dependency contracts without an architecture
gap or additional path reservation.

Organization security guidance was **not fetched or checked**, under the owner's
explicit Seezo waiver for this implementation session. MCP/connectors remained
disabled. No Seezo approval or organization-compliance claim is made.
