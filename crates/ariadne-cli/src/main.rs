fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    if let [command @ ("setup" | "uninstall"), rest @ ..] = args.as_slice() {
        std::process::exit(ariadne_cli::setup::run(
            rest,
            *command == "uninstall",
            &mut std::io::stdout().lock(),
            &mut std::io::stderr().lock(),
        ));
    }
    if let ["doctor", rest @ ..] = args.as_slice() {
        std::process::exit(ariadne_cli::doctor::run(
            rest,
            &mut std::io::stdout().lock(),
            &mut std::io::stderr().lock(),
        ));
    }
    if args.first() == Some(&"open") {
        std::process::exit(ariadne_cli::open::run(
            &args,
            &mut std::io::stdout().lock(),
            &mut std::io::stderr().lock(),
        ));
    }
    if let ["mcp", rest @ ..] = args.as_slice() {
        std::process::exit(ariadne_cli::mcp::run(rest));
    }
    if let ["demo", rest @ ..] = args.as_slice() {
        std::process::exit(ariadne_cli::demo::run(
            rest,
            &mut std::io::stdout().lock(),
            &mut std::io::stderr().lock(),
        ));
    }
    if ariadne_cli::owner::handles(&args) {
        std::process::exit(ariadne_cli::owner::run(
            &args,
            &mut std::io::stdin().lock(),
            &mut std::io::stdout().lock(),
            &mut std::io::stderr().lock(),
        ));
    }
    if ariadne_cli::agent::handles(&args) {
        std::process::exit(ariadne_cli::agent::run(
            &args,
            &mut std::io::stdin().lock(),
            &mut std::io::stdout().lock(),
            &mut std::io::stderr().lock(),
        ));
    }
    if let ["bridge", rest @ ..] = args.as_slice() {
        std::process::exit(ariadne_cli::bridge::command::run(
            rest,
            &mut std::io::stdin().lock(),
            &mut std::io::stdout().lock(),
        ));
    }
    match args.as_slice() {
        [] | ["--help" | "-h"] => println!("ariadne local helper\nUsage: ariadne [--help|--version]\n       ariadne bridge claim --binding UUID --generation UUID --request-id UUID\n       ariadne bridge report --binding UUID --generation UUID --json-stdin\nMCP: ariadne mcp serve (session_read, item_messages, item_rounds, apply). Bridge reports persist through registered Core state even when the desktop is closed.\n\n{}\n{}\n{}\n{}\n{}\n{}", ariadne_cli::agent::HELP, ariadne_cli::owner::HELP, ariadne_cli::demo::HELP, ariadne_cli::open::HELP, ariadne_cli::setup::HELP, ariadne_cli::doctor::HELP),
        ["--version" | "-V"] => println!("ariadne {}", env!("CARGO_PKG_VERSION")),
        _ => {
            eprintln!("Unsupported scaffold request; use --help.");
            std::process::exit(2);
        }
    }
}
