use super::*;

fn route() -> String {
    serde_json::json!({
        "project_id":"00000000-0000-4000-8000-000000000001",
        "session_id":"00000000-0000-4000-8000-000000000002",
        "item_id":"2.1"
    })
    .to_string()
}
fn args(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| value.to_string()).collect()
}

#[test]
fn launch_and_second_instance_use_the_identical_explicit_route() {
    let input = args(&[
        "/Applications/Ariadne with spaces.app/Contents/MacOS/Ariadne",
        "--ariadne-route",
        &route(),
    ]);
    let parsed = parse(&input).unwrap().unwrap();
    assert_eq!(parsed.item_id.unwrap().as_str(), "2.1");
    assert!(parse(&args(&["Ariadne"])).unwrap().is_none());
}

#[test]
fn malformed_routes_do_not_become_navigation_intent() {
    let mut unknown: serde_json::Value = serde_json::from_str(&route()).unwrap();
    unknown["cwd"] = serde_json::json!("/tmp");
    for input in [
        args(&["Ariadne", "--ariadne-route"]),
        args(&[
            "Ariadne",
            "--ariadne-route",
            &route(),
            "--ariadne-route",
            &route(),
        ]),
        args(&["Ariadne", "--ariadne-route", "not json"]),
        args(&["Ariadne", "--ariadne-route", &unknown.to_string()]),
        args(&["Ariadne", "--ariadne-route", &"x".repeat(512 * 1024 + 1)]),
    ] {
        let error = parse(&input).unwrap_err();
        assert_eq!(error.code, CoreErrorCode::InvalidArgument);
        assert!(!error.retryable);
    }
}
