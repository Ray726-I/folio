#[path = "../src/markdown.rs"]
#[allow(dead_code)]
mod markdown;
fn main() {
    let source = std::fs::read_to_string(std::env::args().nth(1).unwrap()).unwrap();
    let (html, blocks) = markdown::render_with_blocks(&source, None, false);
    println!("{}", serde_json::json!({ "html": html, "blocks": blocks }));
}
