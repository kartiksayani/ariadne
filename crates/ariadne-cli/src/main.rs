fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    match args.as_slice() {
        [] | ["--help" | "-h"] => println!("ariadne scaffold\nUsage: ariadne [--help|--version]\nMCP stdio service is not implemented."),
        ["--version" | "-V"] => println!("ariadne {}", env!("CARGO_PKG_VERSION")),
        ["mcp", "serve"] => {
            eprintln!("MCP stdio service is not implemented; no service was started.");
            std::process::exit(2);
        }
        _ => {
            eprintln!("Unsupported scaffold request; use --help.");
            std::process::exit(2);
        }
    }
}
