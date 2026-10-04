//! Canonical global queue projection and rebuild coalescing. Native menu/feed
//! integration remains pending P6.2 work.
pub(crate) mod capture;
mod coalescing;
mod projection;
pub use capture::{capture, WaitingCapture, WaitingRow};
pub use projection::TrayProjection;
