# Published WebDriver key correction

This directory contains the build inputs of the published
`tauri-plugin-wdio-webdriver` 1.4.0 crate, patched for W3C End (`U+E010`)
and Home (`U+E011`) key actions. The existing executor dispatches those keys
with `key`/`code` values `End`/`Home` and legacy key codes 35/36, for both
keydown and keyup. Ariadne consumers keep sending the original W3C keys.

Upstream: <https://github.com/webdriverio/desktop-mobile>, package
`packages/tauri-plugin-webdriver`. Published archive:
<https://static.crates.io/crates/tauri-plugin-wdio-webdriver/tauri-plugin-wdio-webdriver-1.4.0.crate>.
Archive SHA-256:
`52c5e97428174a52b7f4357bbc4535fcce52c6a06c8ee7a379502f7cda1b6045`.
The archive's original `.cargo_vcs_info.json` is preserved, including its
upstream dirty-source flag; the archive checksum identifies the exact source.
The original MIT copyright and license are preserved in `LICENSE`.

The snapshot retains the normalized manifest, build script, all source files,
permissions and upstream README. Registry cache markers, upstream development
configuration, release notes, the original unnormalized manifest and the
standalone upstream lockfile are omitted. Ariadne's root lockfile remains
authoritative. There are no new dependencies or services.
The build-generated permission reference is ignored and not vendored; it is
absent from the published archive.

The upstream Rust source delta is two match arms and the inline
`key_event_tests` module in `src/platform/executor.rs`. The published
`.cargo_vcs_info.json` additionally receives a final newline.
Three upstream Linux comment lines have trailing whitespace removed to satisfy
the repository's unchanged commit checks. Regression tests call
the actual executor method and capture the JavaScript passed to its evaluation
boundary, checking key fields and event direction, absence of text insertion,
retained arrow/letter behavior and error propagation:

```sh
cargo test -p ariadne-desktop -p tauri-plugin-wdio-webdriver \
  --features ariadne-desktop/e2e --lib key_event_tests --locked --offline
```

The existing native tree journey supplies the app/WebView integration proof.
The vendored upstream is outside application coverage inventory; these tests
must still run explicitly because workspace test selection does not test
dependency packages. Selecting the desktop package activates its optional
driver; the filter runs only the driver's focused tests. Replace this snapshot
with a pinned upstream release
containing the correction when available, and remove the patch declaration.

W3C mappings: <https://www.w3.org/TR/webdriver2/#keyboard-actions>.
