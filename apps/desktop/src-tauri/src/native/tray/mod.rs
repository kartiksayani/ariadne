//! Canonical registered queue and the single native observation feed.
pub(crate) mod capture;
mod coalescing;
mod diagnostics;
mod feed;
mod menu;
mod projection;
pub use capture::{capture, WaitingCapture, WaitingRow};
pub use feed::NativeTray;
pub use projection::TrayProjection;
