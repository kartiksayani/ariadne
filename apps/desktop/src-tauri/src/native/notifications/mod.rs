//! Pure queue observation policy. The single native delegate and owning feed
//! integration remain pending P6.2 work; this module does not request permission.
use crate::native::tray::capture;
mod policy;
pub use policy::{evaluate, NotificationPlan};
