//! Where the agent's terminal runs, as a short owner-facing label (ADR-0085).
//!
//! Pure string plumbing over the agent-side process environment: no OS calls,
//! no AppleScript. The label is display text only and grants nothing.

/// Longest stored label, in characters.
pub const MAX_HOST_LOCATION_CHARS: usize = 60;

/// Label from the agent process's `TERM_PROGRAM` and `ITERM_SESSION_ID` values.
/// iTerm adds the 1-based window number parsed from `w<n>t<n>p<n>:<uuid>`.
pub fn host_location(term_program: Option<&str>, iterm_session_id: Option<&str>) -> Option<String> {
    let program = term_program
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    let label = match program {
        "iTerm.app" => match iterm_session_id.and_then(iterm_window) {
            Some(window) => format!("iTerm window {window}"),
            None => "iTerm".to_owned(),
        },
        "Apple_Terminal" => "Terminal".to_owned(),
        "vscode" => "VS Code".to_owned(),
        "WarpTerminal" => "Warp".to_owned(),
        other => other.to_owned(),
    };
    normalize_host_location(&label)
}

/// Label read from this process's environment.
pub fn host_location_from_environment() -> Option<String> {
    let term_program = std::env::var("TERM_PROGRAM").ok();
    let iterm_session_id = std::env::var("ITERM_SESSION_ID").ok();
    host_location(term_program.as_deref(), iterm_session_id.as_deref())
}

/// Trimmed, one-line label of at most [`MAX_HOST_LOCATION_CHARS`] characters.
/// `None` when nothing printable remains. Control characters end the label.
pub fn normalize_host_location(value: &str) -> Option<String> {
    let line = value.trim_start().split(char::is_control).next()?;
    let label: String = line.chars().take(MAX_HOST_LOCATION_CHARS).collect();
    let label = label.trim_end();
    (!label.is_empty()).then(|| label.to_owned())
}

/// True when `value` is already a normalized label.
pub fn is_host_location(value: &str) -> bool {
    normalize_host_location(value).as_deref() == Some(value)
}

/// 1-based window from an iTerm session id such as `w0t1p0:UUID`.
fn iterm_window(session_id: &str) -> Option<u64> {
    let digits = session_id.strip_prefix('w')?;
    let end = digits
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(digits.len());
    if end == 0 || !digits[end..].starts_with('t') {
        return None;
    }
    digits[..end].parse::<u64>().ok()?.checked_add(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_programs_map_to_owner_labels() {
        assert_eq!(
            host_location(Some("Apple_Terminal"), None).as_deref(),
            Some("Terminal")
        );
        assert_eq!(
            host_location(Some("vscode"), None).as_deref(),
            Some("VS Code")
        );
        assert_eq!(
            host_location(Some("WarpTerminal"), None).as_deref(),
            Some("Warp")
        );
        assert_eq!(
            host_location(Some("ghostty"), None).as_deref(),
            Some("ghostty")
        );
        assert_eq!(host_location(None, Some("w0t0p0:ABC")), None);
        assert_eq!(host_location(Some("  "), None), None);
    }

    #[test]
    fn iterm_window_is_one_based_from_the_session_id() {
        let iterm = |id| host_location(Some("iTerm.app"), id);
        assert_eq!(
            iterm(Some("w0t1p0:6E5A")).as_deref(),
            Some("iTerm window 1")
        );
        assert_eq!(
            iterm(Some("w12t0p3:6E5A")).as_deref(),
            Some("iTerm window 13")
        );
        for malformed in [
            "",
            "t0p0:x",
            "w:x",
            "wxt0",
            "w1p0:x",
            "w99999999999999999999t0",
        ] {
            assert_eq!(
                iterm(Some(malformed)).as_deref(),
                Some("iTerm"),
                "{malformed}"
            );
        }
        assert_eq!(iterm(None).as_deref(), Some("iTerm"));
    }

    #[test]
    fn labels_are_trimmed_single_line_and_bounded() {
        assert_eq!(normalize_host_location("  Warp  ").as_deref(), Some("Warp"));
        assert_eq!(normalize_host_location("one\ntwo").as_deref(), Some("one"));
        assert_eq!(normalize_host_location("\n\t "), None);
        let long = "é".repeat(MAX_HOST_LOCATION_CHARS + 5);
        assert_eq!(
            normalize_host_location(&long).map(|value| value.chars().count()),
            Some(MAX_HOST_LOCATION_CHARS)
        );
        assert!(is_host_location("iTerm window 1"));
        assert!(!is_host_location(" iTerm"));
        assert!(!is_host_location("a\nb"));
        assert!(!is_host_location(""));
        assert!(!is_host_location(&long));
    }
}
