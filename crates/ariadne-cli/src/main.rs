fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    if let ["bridge", rest @ ..] = args.as_slice() {
        std::process::exit(ariadne_cli::bridge::command::run(
            rest,
            &mut std::io::stdin().lock(),
            &mut std::io::stdout().lock(),
        ));
    }
    match args.as_slice() {
        [] | ["--help" | "-h"] => println!("ariadne local helper\nUsage: ariadne [--help|--version]\n       ariadne bridge claim --binding UUID --generation UUID --request-id UUID\n       ariadne bridge report --binding UUID --generation UUID --json-stdin\nMCP stdio service is not implemented. Production bridge report composition is not available yet."),
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
