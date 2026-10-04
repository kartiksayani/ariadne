fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    std::process::exit(ariadne_mcp::native::run(&args));
}
