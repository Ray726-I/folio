#[path = "../src/markdown.rs"]
#[allow(dead_code)]
mod markdown;
fn main() {
    let source = std::fs::read_to_string(std::env::args().nth(1).unwrap()).unwrap();
    println!(
        "{}",
        serde_json::json!({"html": markdown::render(&source, None), "blocks": markdown::edit_blocks(&source)})
    );
}
