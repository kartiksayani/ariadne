//! The Dock shows the dark app icon while the system appearance is dark.
//! A bundle's .icns has no appearance variants, so this applies only while
//! Ariadne runs; Finder and a closed app keep the light bundle icon.
use objc2::{AllocAnyThread, MainThreadMarker};
use objc2_app_kit::{NSApplication, NSImage};
use objc2_foundation::NSData;

/// designs/icons/ariadne-icon-dark-1024.png at 512px, the Dock's largest size.
const DARK: &[u8] = include_bytes!("../../../icons/dock-dark.png");

fn dark_icon() -> Option<objc2::rc::Retained<NSImage>> {
    NSImage::initWithData(NSImage::alloc(), &NSData::with_bytes(DARK))
}

/// Call on the UI thread with the window's appearance. Light restores the
/// bundle icon.
pub(crate) fn follow(theme: tauri::Theme) {
    let Some(main) = MainThreadMarker::new() else {
        return;
    };
    let image = match theme {
        tauri::Theme::Dark => dark_icon(),
        _ => None,
    };
    // None is AppKit's documented reset to the bundle icon.
    unsafe { NSApplication::sharedApplication(main).setApplicationIconImage(image.as_deref()) };
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_embedded_dark_icon_decodes_at_dock_size() {
        let image = super::dark_icon().expect("the dark Dock icon decodes");
        let size = image.size();
        assert_eq!((size.width, size.height), (512.0, 512.0));
    }
}
