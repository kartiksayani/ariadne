use std::{fs, os::unix::fs::symlink};
#[test]
fn one_source_generates_identical_adapter_guidance_and_detects_stale_outputs() {
    let root = tempfile::tempdir().unwrap();
    let rules = root.path().join("integrations/rules");
    fs::create_dir_all(&rules).unwrap();
    fs::write(
        rules.join("source.md"),
        "Full exact reply.\nRetain original operation IDs.\n",
    )
    .unwrap();
    ariadne_xtask::rules::generate(root.path(), false).unwrap();
    assert_eq!(
        fs::read(rules.join("claude.md")).unwrap(),
        fs::read(rules.join("codex.md")).unwrap()
    );
    ariadne_xtask::rules::generate(root.path(), true).unwrap();
    fs::write(rules.join("source.md"), "Changed canonical guidance.\n").unwrap();
    assert!(ariadne_xtask::rules::generate(root.path(), true)
        .unwrap_err()
        .contains("Stale"));
    ariadne_xtask::rules::generate(root.path(), false).unwrap();
    ariadne_xtask::rules::generate(root.path(), true).unwrap();
}
#[test]
fn symlinked_rule_target_is_rejected_without_overwriting_unrelated_content() {
    let root = tempfile::tempdir().unwrap();
    let rules = root.path().join("integrations/rules");
    fs::create_dir_all(&rules).unwrap();
    fs::write(rules.join("source.md"), "Valid full reply guidance.\n").unwrap();
    let other = root.path().join("unrelated.md");
    fs::write(&other, "Keep this owner's file.").unwrap();
    symlink(&other, rules.join("claude.md")).unwrap();
    assert!(ariadne_xtask::rules::generate(root.path(), false).is_err());
    assert_eq!(
        fs::read_to_string(other).unwrap(),
        "Keep this owner's file."
    );
}
