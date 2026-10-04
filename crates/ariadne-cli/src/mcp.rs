//! Alias of the same installed SDK service and native agent resolver.
pub fn run(args: &[&str]) -> i32 {
    ariadne_mcp::native::run(args)
}
