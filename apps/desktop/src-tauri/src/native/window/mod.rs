mod desktop;
#[cfg(target_os = "macos")]
pub(crate) mod dock;
pub(crate) mod fullscreen;
pub mod geometry;
pub mod lifecycle;
mod preferences;
pub(crate) mod quit_note;
#[cfg(target_os = "macos")]
pub(crate) mod wake;
#[cfg(test)]
pub(crate) use desktop::{first_show, show_after};
pub(crate) use desktop::{focus_webview, present};
pub use desktop::{Fit, NativeWindow};
#[cfg(test)]
pub(crate) use preferences::WindowPreferenceWrite;
