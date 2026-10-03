use std::io::Read;
fn main() {
    let result = (|| -> Result<_, String> {
        let mut input = String::new();
        std::io::stdin()
            .read_to_string(&mut input)
            .map_err(|e| e.to_string())?;
        let request = serde_json::from_str(&input).map_err(|e| e.to_string())?;
        let response = ariadne_coverage_inventory::verify(request)?;
        serde_json::to_string(&response).map_err(|e| e.to_string())
    })();
    match result {
        Ok(response) => println!("{response}"),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}
