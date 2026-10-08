//! Opens a link from agent text in the owner's default browser or mail app.
//! Only http, https and mailto URLs pass; the URL is one argument to
//! /usr/bin/open, never shell text, and the webview itself never navigates.
use ariadne_core::{CoreError, CoreErrorCode};

const MAX_URL: usize = 2048;

fn refused() -> CoreError {
    CoreError::new(
        CoreErrorCode::InvalidArgument,
        "This link cannot be opened.",
        "Only web (http, https) and email (mailto) links open from Ariadne.",
    )
}

/// The URL to hand to the system when it is a well-formed http, https or mailto link.
pub(crate) fn checked_link(raw: &str) -> Result<String, CoreError> {
    if raw.is_empty()
        || raw.len() > MAX_URL
        || raw.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        return Err(refused());
    }
    let parsed = url::Url::parse(raw).map_err(|_| refused())?;
    match parsed.scheme() {
        "http" | "https" if parsed.host_str().is_some_and(|host| !host.is_empty()) => {}
        "mailto" if !parsed.path().is_empty() => {}
        _ => return Err(refused()),
    }
    let url = parsed.to_string();
    // A checked URL starts with its scheme, so `open` can never read it as an option.
    if url.starts_with('-') || url.len() > MAX_URL {
        return Err(refused());
    }
    Ok(url)
}

#[tauri::command]
pub async fn open_link(url: String) -> Result<(), CoreError> {
    let url = checked_link(&url)?;
    let status = tauri::async_runtime::spawn_blocking(move || {
        std::process::Command::new("/usr/bin/open")
            .arg(url)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
    })
    .await
    .map_err(|_| refused())?;
    match status {
        Ok(status) if status.success() => Ok(()),
        _ => Err(CoreError::new(
            CoreErrorCode::IoError,
            "The link did not open.",
            "Copy the link and open it in your browser.",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::checked_link;

    #[test]
    fn accepts_web_and_mail_links() {
        assert_eq!(
            checked_link("https://github.com/o/r/pull/1").unwrap(),
            "https://github.com/o/r/pull/1"
        );
        assert!(checked_link("http://example.com/a_(b)?q=1#x").is_ok());
        assert!(checked_link("mailto:owner@example.com").is_ok());
    }

    #[test]
    fn refuses_other_schemes() {
        for url in [
            "javascript:alert(1)",
            "JavaScript:alert(1)",
            "file:///etc/hosts",
            "data:text/html,<script>alert(1)</script>",
            "vbscript:x",
            "ftp://example.com/x",
            "-a Calculator",
            "//example.com",
            "https://",
            "mailto:",
            "",
        ] {
            assert!(checked_link(url).is_err(), "{url}");
        }
    }

    #[test]
    fn refuses_injected_whitespace_and_control_characters() {
        for url in [
            "https://example.com/\n--args",
            "https://example.com/\r\nx",
            "https://example.com/ x",
            "https://example.com/\tx",
            "https://example.com/\u{0}x",
            "https://example.com/\u{2028}x",
        ] {
            assert!(checked_link(url).is_err(), "{url:?}");
        }
    }

    #[test]
    fn refuses_a_too_long_link() {
        let long = format!("https://example.com/{}", "a".repeat(2048));
        assert!(checked_link(&long).is_err());
        let fits = format!("https://example.com/{}", "a".repeat(2000));
        assert!(checked_link(&fits).is_ok());
    }
}
