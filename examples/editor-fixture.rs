#[path = "../src/markdown.rs"]
#[allow(dead_code)]
mod markdown;
fn main() {
    let source = std::fs::read_to_string(std::env::args().nth(1).unwrap()).unwrap();
    let allow_remote = std::env::args().nth(2).as_deref() == Some("--allow-remote");
    let (html, _) = match markdown::render_with_blocks_checked(
        &source,
        None,
        allow_remote,
        &markdown::DEFAULT_RENDER_LIMITS,
        false,
    ) {
        Ok(rendered) => rendered,
        Err(error) => (markdown::preview_limit_html(&error), Vec::new()),
    };
    let blocks = markdown::edit_blocks(&source);
    println!("{}", serde_json::json!({ "html": html, "blocks": blocks }));
}
