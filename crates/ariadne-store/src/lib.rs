//! Locked, atomic local session persistence.
mod migrate;
pub mod registry;
pub mod session;
pub mod ui;
pub use session::fs::Directory as OwnedDirectory;
