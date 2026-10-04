use std::process::Command;

#[test]
fn truthful_entrypoint_process_contract() {
    for args in [
        vec![],
        vec!["--help"],
        vec!["-h"],
        vec!["--version"],
        vec!["-V"],
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_ariadne"))
            .args(&args)
            .output()
            .unwrap();
        assert!(output.status.success());
        assert!(output.stderr.is_empty());
        let stdout = String::from_utf8(output.stdout).unwrap();
        assert!(stdout.starts_with("ariadne "));
        if args.contains(&"--version") || args.contains(&"-V") {
            assert_eq!(stdout, format!("ariadne {}\n", env!("CARGO_PKG_VERSION")));
        } else {
            assert!(stdout.contains("Usage:"));
            assert!(stdout.contains("ariadne mcp serve"));
            for tool in ["session_read", "item_messages", "item_rounds", "apply"] {
                assert!(stdout.contains(tool));
            }
        }
    }
    for args in [
        vec!["unknown"],
        vec!["--help", "unknown"],
        vec!["mcp", "serve", "unexpected"],
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_ariadne"))
            .args(&args)
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(2));
        assert!(output.stdout.is_empty());
        let stderr = String::from_utf8(output.stderr).unwrap();
        assert!(stderr.contains("Unsupported"));
    }
}
