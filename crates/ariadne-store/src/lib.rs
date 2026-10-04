//! Locked, atomic local session persistence.
pub mod registry;
pub mod session;
pub mod ui;
pub use session::fs::Directory as OwnedDirectory;
