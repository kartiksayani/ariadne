mod desktop;
pub mod geometry;
pub mod lifecycle;
mod preferences;
#[cfg(target_os = "macos")]
pub(crate) mod wake;
pub use desktop::NativeWindow;
