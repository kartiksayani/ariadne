use ariadne_core::CoreError;
use tauri::{Emitter, Manager};
use url::Url;

#[derive(Debug, PartialEq)]
enum Navigation {
    Allow,
    OpenExternally(String),
    Refuse,
}

fn app_url(dev_url: Option<&Url>, is_dev: bool) -> Url {
    if is_dev {
        if let Some(url) = dev_url {
            return url.clone();
        }
    }
    Url::parse("tauri://localhost").expect("valid packaged app URL")
}

fn decide(raw: &str, app_url: &Url) -> Navigation {
    if raw.is_empty() || raw.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Navigation::Refuse;
    }
    let Ok(url) = Url::parse(raw) else {
        return Navigation::Refuse;
    };
    // Custom protocols have opaque URL origins; compare their components too.
    if url.host_str().is_some()
        && url.scheme() == app_url.scheme()
        && url.host_str() == app_url.host_str()
        && url.port_or_known_default() == app_url.port_or_known_default()
        && url.username().is_empty()
        && url.password().is_none()
    {
        Navigation::Allow
    } else {
        match crate::commands::checked_link(raw) {
            Ok(url) => Navigation::OpenExternally(url),
            Err(_) => Navigation::Refuse,
        }
    }
}

fn report_open_result<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    label: &str,
    result: Result<(), CoreError>,
) {
    if result.is_err()
        && app
            .emit_to(label, "ariadne://open_link_failed", ())
            .is_err()
    {
        eprintln!("Ariadne could not report that the link did not open.");
    }
}

pub(crate) fn plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    // Plugin hooks also cover the main window created from either Tauri config.
    tauri::plugin::Builder::new("navigation-guard")
        .on_navigation(|webview, url| {
            let app_url = app_url(webview.config().build.dev_url.as_ref(), tauri::is_dev());
            match decide(url.as_str(), &app_url) {
                Navigation::Allow => true,
                Navigation::OpenExternally(url) => {
                    let app = webview.app_handle().clone();
                    let label = webview.label().to_owned();
                    tauri::async_runtime::spawn(async move {
                        report_open_result(&app, &label, crate::commands::open_link(url).await);
                    });
                    false
                }
                Navigation::Refuse => false,
            }
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::{app_url, decide, report_open_result, Navigation};
    use ariadne_core::{CoreError, CoreErrorCode};
    use std::sync::mpsc;
    use tauri::Listener;
    use url::Url;

    fn origins() -> [Url; 2] {
        let dev = Url::parse("http://localhost:1420").unwrap();
        [app_url(Some(&dev), true), app_url(Some(&dev), false)]
    }

    #[test]
    fn external_open_failures_emit_only_a_private_window_notice() {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let (events, notices) = mpsc::channel();
        app.listen_any("ariadne://open_link_failed", move |event| {
            events.send(event.payload().to_owned()).unwrap();
        });
        let (global_events, global_notices) = mpsc::channel();
        app.listen("ariadne://open_link_failed", move |_| {
            global_events.send(()).unwrap();
        });

        report_open_result(app.handle(), "main", Ok(()));
        assert!(matches!(notices.try_recv(), Err(mpsc::TryRecvError::Empty)));

        report_open_result(
            app.handle(),
            "main",
            Err(CoreError::new(
                CoreErrorCode::IoError,
                "https://example.com/private-link",
                "Sensitive opener details must not enter the event.",
            )),
        );
        assert_eq!(notices.try_recv().unwrap(), "null");
        assert!(matches!(notices.try_recv(), Err(mpsc::TryRecvError::Empty)));
        assert!(matches!(
            global_notices.try_recv(),
            Err(mpsc::TryRecvError::Empty)
        ));
    }

    #[test]
    fn allows_dev_app_paths_queries_and_fragments() {
        let app = &origins()[0];
        for url in [
            "http://localhost:1420",
            "http://localhost:1420/index.html",
            "http://localhost:1420/detail?q=1#item",
        ] {
            assert_eq!(decide(url, app), Navigation::Allow, "{url}");
        }
    }

    #[test]
    fn allows_packaged_app_paths_queries_and_fragments() {
        let app = &origins()[1];
        for url in [
            "tauri://localhost",
            "tauri://localhost/index.html",
            "tauri://localhost/detail?q=1#item",
        ] {
            assert_eq!(decide(url, app), Navigation::Allow, "{url}");
        }
    }

    #[test]
    fn opens_web_and_mail_links_externally_in_both_modes() {
        for app in origins() {
            for url in [
                "https://github.com/o/r/pull/1",
                "http://example.com/a?q=1#x",
                "mailto:owner@example.com",
            ] {
                assert_eq!(
                    decide(url, &app),
                    Navigation::OpenExternally(url.to_owned()),
                    "{url} from {app}"
                );
            }
        }
    }

    #[test]
    fn refuses_unsafe_schemes_and_malformed_urls_in_both_modes() {
        for app in origins() {
            for url in [
                "javascript:alert(1)",
                "file:///etc/hosts",
                "data:text/html,hello",
                "about:blank",
                "about:srcdoc",
                "ftp://example.com/file",
                "tauri://example.com",
                "",
                "//example.com",
                "https://",
                "http://[invalid]",
                "mailto:",
                "https://example.com/ x",
                "http://localhost:1420/\n",
                "tauri://localhost/\u{0}",
            ] {
                assert_eq!(decide(url, &app), Navigation::Refuse, "{url:?} from {app}");
            }
            let long = format!("https://example.com/{}", "a".repeat(2048));
            assert_eq!(decide(&long, &app), Navigation::Refuse);
        }
    }

    #[test]
    fn refuses_custom_protocol_origin_lookalikes() {
        let app = &origins()[1];
        for url in [
            "tauri://localhost.example.com",
            "tauri://localhost:1420",
            "tauri://owner@localhost",
            "tauri://owner:password@localhost",
            "other://localhost",
        ] {
            assert_eq!(decide(url, app), Navigation::Refuse, "{url}");
        }
    }

    #[test]
    fn opens_other_web_origins_and_userinfo_externally() {
        let app = &origins()[0];
        for url in [
            "https://localhost:1420/",
            "http://localhost:1421/",
            "http://localhost/",
            "http://127.0.0.1:1420/",
            "http://localhost.example.com:1420/",
            "http://owner@localhost:1420/",
        ] {
            assert_eq!(
                decide(url, app),
                Navigation::OpenExternally(url.to_owned()),
                "{url}"
            );
        }
    }

    #[test]
    fn production_does_not_allow_the_configured_dev_origin() {
        assert_eq!(
            decide("http://localhost:1420/", &origins()[1]),
            Navigation::OpenExternally("http://localhost:1420/".to_owned())
        );
        assert_eq!(
            decide("tauri://localhost/", &origins()[0]),
            Navigation::Refuse
        );
    }

    #[test]
    fn dev_origin_comes_from_configuration_and_compares_effective_ports() {
        let configured = Url::parse("http://localhost:1540/app").unwrap();
        let app = app_url(Some(&configured), true);
        assert_eq!(
            decide("http://localhost:1540/detail", &app),
            Navigation::Allow
        );
        let app = Url::parse("http://localhost").unwrap();
        assert_eq!(
            decide("http://localhost:80/detail", &app),
            Navigation::Allow
        );
    }

    #[test]
    fn dev_without_a_server_uses_packaged_assets() {
        assert_eq!(app_url(None, true), origins()[1]);
    }
}
