use base64::{engine::general_purpose::STANDARD, Engine};
use comrak::{
    adapters::SyntaxHighlighterAdapter,
    nodes::{LineColumn, NodeValue},
    options::{Plugins, RenderPlugins},
    parse_document,
    plugins::syntect::SyntectAdapter,
    Arena, Options,
};
use std::{
    borrow::Cow,
    collections::{HashMap, HashSet},
    fs,
    path::Path,
    sync::{Arc, LazyLock},
};

#[derive(serde::Serialize)]
pub struct EditBlock {
    pub start: usize,
    pub end: usize,
    pub source: String,
    pub sourcepos: String,
    pub nodes: Vec<EditNode>,
}

#[derive(serde::Serialize)]
pub struct EditNode {
    pub start: usize,
    pub end: usize,
    pub sourcepos: String,
    pub kind: &'static str,
    pub text: Option<String>,
}

fn markdown_options() -> Options<'static> {
    let mut options = Options::default();
    let extension = &mut options.extension;
    extension.strikethrough = true;
    extension.table = true;
    extension.autolink = true;
    extension.tasklist = true;
    extension.superscript = true;
    extension.footnotes = true;
    extension.inline_footnotes = true;
    extension.description_lists = true;
    extension.multiline_block_quotes = true;
    extension.alerts = true;
    extension.math_dollars = true;
    extension.math_code = true;
    extension.shortcodes = true;
    extension.wikilinks_title_after_pipe = true;
    extension.subscript = true;
    extension.highlight = true;
    extension.insert = true;
    extension.front_matter_delimiter = Some("---".into());
    extension.header_id_prefix = Some("doc-".into());
    options
}
fn byte_offset(source: &str, position: LineColumn) -> Option<usize> {
    let mut offset = 0usize;
    for (index, line) in source.split('\n').enumerate() {
        let line_number = index + 1;
        if line_number == position.line {
            return Some(offset + position.column.checked_sub(1)?);
        }
        offset += line.len() + 1;
    }
    None
}
fn node_range(source: &str, node: &comrak::nodes::AstNode) -> Option<(usize, usize)> {
    let position = node.data().sourcepos;
    let start = byte_offset(source, position.start)?;
    let end = byte_offset(source, position.end)? + 1;
    Some((start, end))
}
pub fn edit_blocks(source: &str) -> Vec<EditBlock> {
    let options = markdown_options();
    let arena = Arena::new();
    let root = parse_document(&arena, source, &options);
    let mut blocks = Vec::new();
    let mut child = root.first_child();
    while let Some(node) = child {
        if let Some((start, end)) = node_range(source, node) {
            if let Some(text) = source.get(start..end) {
                blocks.push(EditBlock {
                    start,
                    end,
                    source: text.into(),
                    sourcepos: node.data().sourcepos.to_string(),
                    nodes: node
                        .descendants()
                        .filter_map(|descendant| {
                            let (start, end) = node_range(source, descendant)?;
                            source.get(start..end)?;
                            let data = descendant.data();
                            let (kind, text) = match &data.value {
                                NodeValue::Text(text) => ("text", Some(text.to_string())),
                                NodeValue::Paragraph => ("paragraph", None),
                                NodeValue::Heading(_) => ("heading", None),
                                NodeValue::CodeBlock(_) => ("code-block", None),
                                NodeValue::Code(code) => ("code", Some(code.literal.clone())),
                                NodeValue::Math(math) => ("math", Some(math.literal.clone())),
                                NodeValue::Table(_) => ("table", None),
                                NodeValue::Item(_) | NodeValue::TaskItem(_) => ("item", None),
                                _ => ("structure", None),
                            };
                            Some(EditNode {
                                start,
                                end,
                                sourcepos: data.sourcepos.to_string(),
                                kind,
                                text,
                            })
                        })
                        .collect(),
                });
            }
        }
        child = node.next_sibling();
    }
    blocks
}
pub fn set_task_checked(source: &str, task_index: usize, checked: bool) -> String {
    let options = markdown_options();
    let arena = Arena::new();
    let root = parse_document(&arena, source, &options);
    let mut index = 0usize;
    for node in root.descendants() {
        if let NodeValue::TaskItem(item) = &node.data().value {
            if index == task_index {
                if let Some(offset) = byte_offset(source, item.symbol_sourcepos.start) {
                    let mut updated = source.to_owned();
                    updated.replace_range(offset..offset + 1, if checked { "x" } else { " " });
                    return updated;
                }
                return source.to_owned();
            }
            index += 1;
        }
    }
    source.to_owned()
}

static SYNTAXES: LazyLock<SyntectAdapter> = LazyLock::new(|| SyntectAdapter::new(None));
struct SourceHighlighter;
impl SyntaxHighlighterAdapter for SourceHighlighter {
    fn write_highlighted(
        &self,
        output: &mut dyn std::fmt::Write,
        lang: Option<&str>,
        code: &str,
    ) -> std::fmt::Result {
        SYNTAXES.write_highlighted(output, lang, code)
    }
    fn write_pre_tag(
        &self,
        output: &mut dyn std::fmt::Write,
        mut attributes: HashMap<&'static str, Cow<'_, str>>,
    ) -> std::fmt::Result {
        attributes.insert("class", "syntax-highlighting".into());
        comrak::html::write_opening_tag(output, "pre", attributes)
    }
    fn write_code_tag(
        &self,
        output: &mut dyn std::fmt::Write,
        attributes: HashMap<&'static str, Cow<'_, str>>,
    ) -> std::fmt::Result {
        SYNTAXES.write_code_tag(output, attributes)
    }
}

fn local_image(destination: &str, base: Option<&Path>) -> Option<String> {
    if destination.starts_with("https://") {
        return Some(destination.into());
    }
    if destination.contains(':') || destination.starts_with('/') {
        return None;
    }
    let base = base?.canonicalize().ok()?;
    let decoded = percent_encoding::percent_decode_str(destination)
        .decode_utf8()
        .ok()?;
    let path = base.join(decoded.as_ref()).canonicalize().ok()?;
    if !path.starts_with(&base) {
        return None;
    }
    let mime = match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        _ => return None,
    };
    if fs::metadata(&path).ok()?.len() > 10 * 1024 * 1024 {
        return None;
    }
    Some(format!(
        "data:{mime};base64,{}",
        STANDARD.encode(fs::read(path).ok()?)
    ))
}
fn patch_task_items(html: &str, task_indices: &HashMap<String, usize>) -> String {
    let mut output = String::with_capacity(html.len());
    let mut rest = html;
    let mut annotated = HashSet::new();
    while let Some(position) = rest.find("<input type=\"checkbox\"") {
        let start = position + "<input type=\"checkbox\"".len();
        let Some(end) = rest[start..].find('>') else {
            break;
        };
        let end = start + end;
        output.push_str(&rest[..start]);
        let input_attributes = &rest[start..end];
        let list_item = rest[..position].rfind("<li data-sourcepos=\"");
        let task_index = list_item.and_then(|list_item| {
            let sourcepos_start = list_item + "<li data-sourcepos=\"".len();
            let sourcepos_end = rest[sourcepos_start..].find('"')? + sourcepos_start;
            let sourcepos = &rest[sourcepos_start..sourcepos_end];
            (!rest[list_item..position].contains("</li>")
                && input_attributes.contains(" disabled=\"\"")
                && annotated.insert(sourcepos.to_owned()))
            .then(|| task_indices.get(sourcepos).copied())
            .flatten()
        });
        if let Some(index) = task_index {
            output.push_str(&format!(" data-task-index=\"{index}\""));
        }
        output.push_str(input_attributes);
        output.push('>');
        rest = &rest[end + 1..];
    }
    output.push_str(rest);
    output
}

pub fn render(source: &str, base: Option<&Path>) -> String {
    let mut options = markdown_options();
    options.render.r#unsafe = true;
    options.render.sourcepos = true;
    let base = base.map(Path::to_path_buf);
    options.extension.image_url_rewriter = Some(Arc::new(move |url: &str| {
        local_image(url, base.as_deref()).unwrap_or_default()
    }));
    let plugins = Plugins {
        render: RenderPlugins {
            codefence_syntax_highlighter: Some(&SourceHighlighter),
            ..Default::default()
        },
    };
    let arena = Arena::new();
    let root = parse_document(&arena, source, &options);
    let task_indices: HashMap<_, _> = root
        .descendants()
        .filter(|node| matches!(node.data().value, NodeValue::TaskItem(_)))
        .map(|node| node.data().sourcepos.to_string())
        .enumerate()
        .map(|(index, sourcepos)| (sourcepos, index))
        .collect();
    let mut html = String::new();
    comrak::format_html_with_plugins(root, &options, &mut html, &plugins)
        .expect("writing Markdown HTML to a string cannot fail");
    sanitize(&patch_task_items(&html, &task_indices))
}

fn sanitize(html: &str) -> String {
    let mut sanitizer = ammonia::Builder::default();
    sanitizer
        .add_generic_attributes([
            "class",
            "id",
            "data-math-style",
            "data-sourcepos",
            "data-footnote-ref",
            "data-footnote-backref",
            "data-heading-content",
            "data-wikilink",
        ])
        .add_tags(["section", "input"])
        .add_tag_attributes("input", ["type", "checked", "disabled", "data-task-index"])
        .add_tag_attributes("section", ["data-footnotes"])
        .add_tag_attributes("th", ["style"])
        .add_tag_attributes("td", ["style"])
        .url_schemes(HashSet::from(["https", "http", "mailto", "data"]))
        .attribute_filter(|_, attribute, value| match attribute {
            "id" if !value.starts_with("doc-") => Some(Cow::Owned(format!("doc-{value}"))),
            "id" => Some(Cow::Borrowed(value)),
            "href" if value.starts_with('#') => Some(Cow::Owned(format!("#doc-{}", &value[1..]))),
            "style"
                if ![
                    "text-align: left",
                    "text-align: right",
                    "text-align: center",
                ]
                .contains(&value.trim().trim_end_matches(';')) =>
            {
                None
            }
            _ => Some(Cow::Borrowed(value)),
        })
        .link_rel(Some("noopener noreferrer"));
    sanitizer.clean(html).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn editable_blocks_keep_list_text_in_one_source_span() {
        let source = "# Tasks\n\n- [x] Tables, task lists, and footnotes\n- [ ] Your next idea\n\nAfter the list.\n";
        let blocks = edit_blocks(source);
        assert_eq!(blocks.len(), 3);
        assert!(blocks[1]
            .source
            .contains("Tables, task lists, and footnotes"));
        assert!(blocks[1].source.contains("Your next idea"));
        let mut changed = source.to_owned();
        changed.replace_range(blocks[1].start..blocks[1].end, "- [ ] Updated item\n");
        assert!(changed.starts_with("# Tasks\n\n"));
        assert!(changed.ends_with("After the list.\n"));
    }

    #[test]
    fn renders_tables_tasks_footnotes_and_code_safely() {
        let rendered = render("# Title\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n- [x] Done\n\n```rust\nfn main() {}\n```\n\nNote[^1]\n\n[^1]: footnote\n\n<script>alert(1)</script><img src=x onerror=alert(1)>\n\n[bad](javascript:alert(1))", None);
        assert!(rendered.contains("id=\"doc-title\""));
        assert!(rendered.contains("<table data-sourcepos="));
        assert!(rendered.contains("data-task-index=\"0\""));
        assert!(
            rendered.contains("class=\"storage"),
            "Syntax highlighting missing: {rendered}"
        );
        assert!(rendered.contains("footnotes"));
        assert!(!rendered.contains("<script"));
        assert!(!rendered.contains("onerror"));
        assert!(!rendered.contains("javascript:"));
    }

    #[test]
    fn raw_html_checkboxes_do_not_shift_task_indices() {
        let rendered = render(
            "<input type=\"checkbox\"> Custom\n\n<input type=\"checkbox\" disabled=\"\"> Custom disabled\n\n- [ ] First task\n- [x] Second task\n",
            None,
        );
        let task_indices: Vec<_> = rendered
            .split("data-task-index=\"")
            .skip(1)
            .map(|part| part.split('"').next().unwrap())
            .collect();
        assert_eq!(task_indices, ["0", "1"], "{rendered}");
        assert!(rendered.contains("<input type=\"checkbox\"> Custom"));
        assert!(rendered.contains("<input type=\"checkbox\" disabled=\"\"> Custom disabled"));
    }

    #[test]
    fn heading_links_work_and_content_cannot_duplicate_app_ids() {
        let rendered = render(
            "# Title\n\n[Jump](#title)\n\n# Title\n\n<div id=\"command-search\">HTML</div>",
            None,
        );
        assert!(rendered.contains("href=\"#doc-title\""));
        assert!(rendered.contains("id=\"doc-title-1\""));
        assert!(rendered.contains("id=\"doc-command-search\""));
        assert!(!rendered.contains("id=\"command-search\""));
    }

    #[test]
    fn renders_callout_labels_and_preserves_only_safe_table_alignment() {
        let rendered = render("> [!NOTE]\n> A note\n\n| A | B |\n| :--- | ---: |\n| 1 | 2 |\n\n<table><tr><td style=\"position:fixed\">unsafe style</td></tr></table>", None);
        assert!(rendered.contains("markdown-alert-title\">Note</p>"));
        assert!(rendered.contains("align=\"right\""));
        assert!(!rendered.contains("position:fixed"));
    }

    #[test]
    fn math_spans_are_kept_for_client_rendering() {
        let rendered = render(
            "Inline $x^2$ and display $$y^2$$.\n\n```math\nz^2\n```",
            None,
        );
        assert!(rendered.contains("data-math-style=\"inline\""));
        assert!(rendered.contains(">x^2<"));
        assert!(rendered.contains("data-math-style=\"display\">z^2"));
    }

    #[test]
    fn mermaid_blocks_keep_their_source_language() {
        let rendered = render("```mermaid\ngraph TD\nA --> B\n```", None);
        assert!(rendered.contains("class=\"language-mermaid\""));
        assert!(rendered.contains("graph TD"));
        assert!(rendered.contains("data-sourcepos=\"1:1-4:3\""));
    }

    #[test]
    fn live_edit_nodes_preserve_unicode_inline_and_nested_code_ranges() {
        let source =
            "# Café \u{1f600}\n\nA **bold** &amp; \\*word\\*.\n\n> ```rust\n> let café = 1;\n> ```\n";
        let blocks = edit_blocks(source);
        let nodes: Vec<_> = blocks.iter().flat_map(|block| &block.nodes).collect();
        let bold = nodes
            .iter()
            .find(|node| node.text.as_deref() == Some("bold"))
            .unwrap();
        assert_eq!(&source[bold.start..bold.end], "bold");
        let heading = nodes.iter().find(|node| node.kind == "heading").unwrap();
        assert_eq!(&source[heading.start..heading.end], "# Café \u{1f600}");
        let code = nodes.iter().find(|node| node.kind == "code-block").unwrap();
        assert!(source[code.start..code.end].contains("let café = 1;"));
        assert!(render(source, None).contains(&format!("data-sourcepos=\"{}\"", code.sourcepos)));
        assert!(nodes
            .iter()
            .all(|node| source.is_char_boundary(node.start) && source.is_char_boundary(node.end)));
    }

    #[test]
    fn wikilinks_emoji_highlights_and_description_lists_render() {
        let rendered = render(
            "[[guide/roads|Road guide]] with :sparkles:.\n\n==mark== and ++added++ and H~2~O.\n\nA term\n\n: A definition",
            None,
        );
        assert!(rendered.contains("data-wikilink=\"true\""));
        assert!(rendered.contains("\u{2728}"));
        assert!(rendered.contains("<mark") && rendered.contains(">mark</mark>"));
        assert!(rendered.contains("<ins") && rendered.contains(">added</ins>"));
        assert!(rendered.contains("<sub") && rendered.contains(">2</sub>"));
        assert!(rendered.contains("<dl"));
        assert!(rendered.contains("<dd"));
    }

    #[test]
    fn front_matter_is_hidden_from_the_preview() {
        let rendered = render("---\ntitle: Hidden\n---\n# Real title\n", None);
        assert!(rendered.contains("id=\"doc-real-title\""));
        assert!(!rendered.contains("Hidden"));
    }

    #[test]
    fn source_positions_map_visible_blocks_despite_front_matter_and_footnotes() {
        let source = "---\ntitle: Hidden\n---\n\n# Visible\n\nEditable **paragraph**.[^note]\n\n[^note]: Footnote text\n";
        let html = render(source, None);
        let blocks = edit_blocks(source);
        let paragraph = blocks
            .iter()
            .find(|block| block.source.starts_with("Editable"))
            .unwrap();
        assert!(html.contains(&format!(
            "<p data-sourcepos=\"{}\">Editable",
            paragraph.sourcepos
        )));
        let heading = blocks
            .iter()
            .find(|block| block.source.starts_with("# Visible"))
            .unwrap();
        assert!(html.contains(&format!("data-sourcepos=\"{}\"", heading.sourcepos)));
        let mut updated = source.to_owned();
        updated.replace_range(
            paragraph.start..paragraph.end,
            "Changed **paragraph**.[^note]",
        );
        assert!(updated.starts_with("---\ntitle: Hidden\n---\n"));
        assert!(updated.ends_with("[^note]: Footnote text\n"));
        assert!(!updated.contains("Editable"));
    }

    #[test]
    fn toggling_a_task_box_keeps_all_list_text() {
        let original = "# Tasks\n\n- [x] Tables, task lists, and footnotes\n- [x] Code with syntax highlighting\n- [ ] Your next idea\n";
        let updated = set_task_checked(original, 2, true);
        assert_eq!(
            updated,
            original.replace("- [ ] Your next idea", "- [x] Your next idea")
        );
        let unchecked = set_task_checked(original, 0, false);
        assert_eq!(unchecked, original.replace("- [x] Tables", "- [ ] Tables"));
    }

    #[test]
    fn local_images_cannot_escape_document_directory() {
        let directory = tempfile::tempdir().unwrap();
        let base = directory.path().join("notes");
        fs::create_dir(&base).unwrap();
        fs::write(base.join("image.png"), b"image").unwrap();
        fs::write(directory.path().join("secret.png"), b"secret").unwrap();
        assert!(local_image("image.png", Some(&base))
            .unwrap()
            .starts_with("data:image/png;base64,"));
        assert!(local_image("../secret.png", Some(&base)).is_none());
        assert!(local_image("%2e%2e/secret.png", Some(&base)).is_none());
    }
}
