use comrak::{
    adapters::SyntaxHighlighterAdapter,
    nodes::{AstNode, NodeValue},
    options::{Plugins, RenderPlugins},
    parse_document,
    plugins::syntect::SyntectAdapter,
    Arena, Options,
};
use std::{
    borrow::Cow,
    collections::{hash_map::DefaultHasher, HashMap, HashSet, VecDeque},
    fmt,
    hash::{Hash, Hasher},
    path::Path,
    sync::{Arc, LazyLock, Mutex},
};

#[path = "markdown/author_html.rs"]
mod author_html;
#[path = "markdown/images.rs"]
mod images;
#[path = "markdown/limits.rs"]
mod limits;

use limits::{preflight, LineIndex};
pub use limits::{PreviewLimitError, PreviewLimitKind, RenderLimits, DEFAULT_RENDER_LIMITS};

#[derive(Debug, serde::Serialize)]
pub struct EditBlock {
    pub start: usize,
    pub end: usize,
    /// Kept for Rust tests and the debug fixture; the UI slices `current.content`
    /// from the byte range instead, so this field is not sent over IPC.
    #[allow(dead_code)]
    #[serde(skip_serializing)]
    pub source: String,
    pub sourcepos: String,
    pub nodes: Vec<EditNode>,
}

#[derive(Debug, serde::Serialize)]
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
    // Native Comrak's LaTeX grammar is authoritative for preview/export. It
    // intentionally differs from the rich editor's JS tokenizer for escaped
    // backslashes and multiline inline math; see the parity tests below.
    extension.math_latex = true;
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
fn node_range(
    line_starts: &LineIndex,
    source: &str,
    node: &comrak::nodes::AstNode,
) -> Option<(usize, usize)> {
    let position = node.data().sourcepos;
    let start = line_starts.offset(source, position.start)?;
    let end = line_starts.end_offset(source, position.end)?;
    if end < start {
        return None;
    }
    Some((start, end))
}

fn check_node_budget<'a>(
    root: &'a AstNode<'a>,
    limits: &RenderLimits,
) -> Result<usize, PreviewLimitError> {
    let count = root.descendants().count();
    if count > limits.max_ast_nodes {
        return Err(PreviewLimitError::new(
            PreviewLimitKind::AstNodes,
            format!(
                "This document has more than the {} preview syntax nodes allowed.",
                limits.max_ast_nodes
            ),
        ));
    }
    Ok(count)
}

/// Cheaply probe whether [`render_with_blocks_checked`] would reject `source`
/// for a structural budget reason.
///
/// This runs the same preflight scan (source bytes, line count, blockquote
/// nesting depth, and the conservative LaTeX math scanning budget), parses the
/// source with the same options used by the renderer
/// (`markdown_options()`, `render.r#unsafe = true`, `render.sourcepos = true`),
/// and then checks the AST node budget. It returns the first failure, or `None`
/// when the document is within those budgets.
///
/// It deliberately does *not* render HTML, sanitize output, resolve images, or
/// build edit blocks. That makes it a cheap approximation of the render budget:
/// it covers source size, line count, nesting depth, LaTeX math scan work, and
/// AST node count, but it does not predict the HTML-byte or image-byte limits
/// that only rendering can discover.
pub fn preview_check(source: &str, limits: &RenderLimits) -> Option<PreviewLimitError> {
    if let Err(error) = preflight(source, limits) {
        return Some(error);
    }
    let mut options = markdown_options();
    options.render.r#unsafe = true;
    options.render.sourcepos = true;
    let arena = Arena::new();
    let root = parse_document(&arena, source, &options);
    check_node_budget(root, limits).err()
}

#[allow(dead_code)] // used by unit tests and the editor fixture
pub fn edit_blocks(source: &str) -> Vec<EditBlock> {
    edit_blocks_checked(source, &DEFAULT_RENDER_LIMITS).unwrap_or_default()
}

pub fn edit_blocks_checked(
    source: &str,
    limits: &RenderLimits,
) -> Result<Vec<EditBlock>, PreviewLimitError> {
    preflight(source, limits)?;
    let options = markdown_options();
    let arena = Arena::new();
    let root = parse_document(&arena, source, &options);
    check_node_budget(root, limits)?;
    let line_starts = LineIndex::new(source);
    Ok(blocks_from_root(root, source, &line_starts))
}

fn blocks_from_root<'a>(
    root: &'a AstNode<'a>,
    source: &str,
    line_starts: &LineIndex,
) -> Vec<EditBlock> {
    let mut blocks = Vec::new();
    let mut child = root.first_child();
    while let Some(node) = child {
        if let Some((start, end)) = node_range(line_starts, source, node) {
            if let Some(text) = source.get(start..end) {
                blocks.push(EditBlock {
                    start,
                    end,
                    source: text.into(),
                    sourcepos: node.data().sourcepos.to_string(),
                    nodes: node
                        .descendants()
                        .filter_map(|descendant| {
                            let (start, end) = node_range(line_starts, source, descendant)?;
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
    set_task_checked_with_limits(source, task_index, checked, &DEFAULT_RENDER_LIMITS)
}

/// Toggle a parser-discovered task. Structural limits apply here too: an
/// over-budget document is returned byte-for-byte unchanged rather than being
/// partially parsed or truncated.
pub fn set_task_checked_with_limits(
    source: &str,
    task_index: usize,
    checked: bool,
    limits: &RenderLimits,
) -> String {
    if preflight(source, limits).is_err() {
        return source.to_owned();
    }
    let options = markdown_options();
    let arena = Arena::new();
    let root = parse_document(&arena, source, &options);
    if check_node_budget(root, limits).is_err() {
        return source.to_owned();
    }
    let line_starts = LineIndex::new(source);
    let mut index = 0usize;
    for node in root.descendants() {
        if let NodeValue::TaskItem(item) = &node.data().value {
            if index == task_index {
                if let Some(offset) = line_starts.offset(source, item.symbol_sourcepos.start) {
                    if source.get(offset..offset + 1).is_none() {
                        return source.to_owned();
                    }
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

/// Fences larger than this are highlighted on every render instead of being
/// cached. The cap keeps one huge fence from evicting the whole cache and from
/// pinning an unbounded amount of highlighted HTML in memory.
const MAX_HIGHLIGHT_BYTES: usize = 64 * 1024;
const MAX_HIGHLIGHT_CACHE_ENTRIES: usize = 256;
const MAX_HIGHLIGHT_CACHE_BYTES: usize = 8 * 1024 * 1024;

/// Cache key: the requested language (empty when absent) plus a hash of the
/// code. The rendered HTML depends on nothing else: the theme is fixed in
/// [`SYNTAXES`]. A hash collision could in principle serve the wrong
/// highlighting, but the key is never used for security decisions.
type HighlightKey = (String, u64);

#[derive(Default)]
struct HighlightCache {
    entries: HashMap<HighlightKey, Arc<str>>,
    /// Insertion order, so the oldest entry is evicted first.
    order: VecDeque<HighlightKey>,
    bytes: usize,
}

impl HighlightCache {
    fn insert(&mut self, key: HighlightKey, html: String) {
        let bytes = html.len();
        if bytes > MAX_HIGHLIGHT_CACHE_BYTES {
            return;
        }
        let html: Arc<str> = Arc::from(html);
        if let Some(previous) = self.entries.insert(key.clone(), html) {
            self.bytes = self.bytes.saturating_sub(previous.len()) + bytes;
            return;
        }
        self.bytes += bytes;
        self.order.push_back(key);
        while self.entries.len() > MAX_HIGHLIGHT_CACHE_ENTRIES
            || self.bytes > MAX_HIGHLIGHT_CACHE_BYTES
        {
            let Some(oldest) = self.order.pop_front() else {
                break;
            };
            if let Some(evicted) = self.entries.remove(&oldest) {
                self.bytes = self.bytes.saturating_sub(evicted.len());
            }
        }
    }
}

static HIGHLIGHT_CACHE: LazyLock<Mutex<HighlightCache>> =
    LazyLock::new(|| Mutex::new(HighlightCache::default()));

fn highlight_key(lang: Option<&str>, code: &str) -> HighlightKey {
    let mut hasher = DefaultHasher::new();
    code.hash(&mut hasher);
    (lang.unwrap_or_default().to_owned(), hasher.finish())
}

fn write_highlighted_uncached(lang: Option<&str>, code: &str) -> String {
    let mut html = String::new();
    if SYNTAXES.write_highlighted(&mut html, lang, code).is_err() {
        return code.to_owned();
    }
    html
}

/// Highlight `code` as `lang` and return the inner code HTML. Results are
/// reused from a bounded process-wide cache; fences over [`MAX_HIGHLIGHT_BYTES`]
/// are highlighted uncached, as before. The output is deterministic: the theme
/// is fixed in [`SYNTAXES`] and only `lang` and `code` affect it.
pub(crate) fn highlight_html(lang: Option<&str>, code: &str) -> String {
    if code.len() > MAX_HIGHLIGHT_BYTES {
        return write_highlighted_uncached(lang, code);
    }
    let key = highlight_key(lang, code);
    if let Some(html) = HIGHLIGHT_CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .entries
        .get(&key)
    {
        return html.to_string();
    }
    let html = write_highlighted_uncached(lang, code);
    HIGHLIGHT_CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(key, html.clone());
    html
}

/// Highlight one fenced code block without parsing Markdown, sanitizing a
/// whole document, or touching images.
pub fn highlight_code(code: &str, lang: Option<&str>) -> String {
    let mut html = highlight_html(lang, code);
    strip_trailing_newline(&mut html);
    html
}

/// Remove exactly one trailing newline, if there is one. The rendered code
/// element is newline-terminated; the editor mirrors that terminator itself.
fn strip_trailing_newline(html: &mut String) {
    if html.ends_with('\n') {
        html.pop();
    }
}

struct SourceHighlighter;
impl SyntaxHighlighterAdapter for SourceHighlighter {
    fn write_highlighted(
        &self,
        output: &mut dyn std::fmt::Write,
        lang: Option<&str>,
        code: &str,
    ) -> std::fmt::Result {
        output.write_str(&highlight_html(lang, code))
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

const BLOCKED_REMOTE_IMAGE: &str = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIzMjAiIGhlaWdodD0iNDgiPjxyZWN0IHdpZHRoPSIxMDAlIiBoZWlnaHQ9IjEwMCUiIGZpbGw9IiM4ODg4ODgxOCIgc3Ryb2tlPSIjODg4ODg4NjYiLz48dGV4dCB4PSI1MCUiIHk9IjUwJSIgZG9taW5hbnQtYmFzZWxpbmU9Im1pZGRsZSIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZm9udC1mYW1pbHk9InNhbnMtc2VyaWYiIGZvbnQtc2l6ZT0iMTIiIGZpbGw9IiM4ODg4ODgiPlJlbW90ZSBpbWFnZSBibG9ja2VkPC90ZXh0Pjwvc3ZnPg==";
const LOCAL_IMAGE_PLACEHOLDER: &str = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIzMjAiIGhlaWdodD0iNDgiIHJvbGU9ImltZyIgYXJpYS1sYWJlbD0iSW1hZ2UgdW5hdmFpbGFibGUiPjxyZWN0IHdpZHRoPSIxMDAlIiBoZWlnaHQ9IjEwMCUiIGZpbGw9IiM4ODg4ODgxOCIgc3Ryb2tlPSIjODg4ODg4NjYiLz48dGV4dCB4PSI1MCUiIHk9IjUwJSIgZG9taW5hbnQtYmFzZWxpbmU9Im1pZGRsZSIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZm9udC1mYW1pbHk9InNhbnMtc2VyaWYiIGZvbnQtc2l6ZT0iMTIiIGZpbGw9IiM4ODg4ODgiPkltYWdlIHVuYXZhaWxhYmxlPC90ZXh0Pjwvc3ZnPg==";

/// Does this image destination name a remote web host? Browsers normalize
/// `https:host/x`, `https:/host/x`, `https:\host\x`, protocol-relative
/// `//host/x`, and URLs with embedded tabs or newlines into the same HTTP(S)
/// request, so a literal `https://` prefix test would let those forms through
/// and disclose the document to the host even with remote images blocked.
fn remote_image_url(destination: &str) -> bool {
    let cleaned: String = destination
        .chars()
        .filter(|character| !matches!(character, '\t' | '\n' | '\r'))
        .collect();
    let normalized =
        cleaned.trim_matches(|character: char| character.is_ascii_control() || character == ' ');
    // Windows browsers normalize backslashes in special-scheme URLs. `\host`
    // and `/\host` and `\/host` can all become an HTTP(S) authority, so the
    // authority check must be made after that normalization too.
    let slashed = normalized.replace('\\', "/");
    let lower = slashed.to_ascii_lowercase();
    lower.starts_with("//")
        || lower.starts_with("http:")
        || lower.starts_with("https:")
        || normalized.starts_with('\\')
}

/// URL parsing ignores ASCII tab/newline/carriage-return characters inside a
/// scheme. Attribute values can acquire those through entities such as
/// `data&#10;:`, so scheme checks normalize them before inspecting the prefix.
pub(crate) fn is_data_url(value: &str) -> bool {
    let cleaned: String = value
        .chars()
        .filter(|character| !matches!(character, '\t' | '\n' | '\r'))
        .collect();
    let normalized = cleaned
        .trim_start_matches(|character: char| character.is_ascii_control() || character == ' ');
    normalized
        .get(..5)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("data:"))
}

#[allow(dead_code)]
fn local_image(
    destination: &str,
    base: Option<&Path>,
    allow_remote_images: bool,
) -> Option<String> {
    images::local_image(destination, base, allow_remote_images)
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

/// Render Markdown using Folio's default privacy posture (remote images blocked).
#[allow(dead_code)] // used by unit tests and the editor fixture
pub fn render(source: &str, base: Option<&Path>) -> String {
    match render_with_blocks_checked(source, base, false, &DEFAULT_RENDER_LIMITS, false) {
        Ok((html, _)) => html,
        Err(error) => preview_limit_html(&error),
    }
}

/// Render Markdown and build the edit map from a single parse. `allow_remote_images`
/// is the user's persisted preference; blocking returns a local placeholder instead
/// of making a network request.
///
/// The return shape is unchanged for the current native/UI consumers. A budget
/// failure returns a diagnostic HTML block with no edit blocks instead of
/// truncating or mutating the source. Callers that need structured failures can
/// use [`render_with_blocks_checked`].
#[allow(dead_code)] // used by unit tests and the editor fixture
pub fn render_with_blocks(
    source: &str,
    base: Option<&Path>,
    allow_remote_images: bool,
) -> (String, Vec<EditBlock>) {
    match render_with_blocks_checked(
        source,
        base,
        allow_remote_images,
        &DEFAULT_RENDER_LIMITS,
        true,
    ) {
        Ok(rendered) => rendered,
        Err(error) => (preview_limit_html(&error), Vec::new()),
    }
}

pub fn render_with_blocks_checked(
    source: &str,
    base: Option<&Path>,
    allow_remote_images: bool,
    limits: &RenderLimits,
    include_blocks: bool,
) -> Result<(String, Vec<EditBlock>), PreviewLimitError> {
    preflight(source, limits)?;
    let mut options = markdown_options();
    options.render.r#unsafe = true;
    options.render.sourcepos = true;
    let base = base.and_then(|path| path.canonicalize().ok());
    let rewriter_limits = *limits;
    options.extension.image_url_rewriter = Some(Arc::new(move |url: &str| {
        images::resolve_image(url, base.as_deref(), allow_remote_images, &rewriter_limits)
    }));
    let plugins = Plugins {
        render: RenderPlugins {
            codefence_syntax_highlighter: Some(&SourceHighlighter),
            ..Default::default()
        },
    };
    let arena = Arena::new();
    let root = parse_document(&arena, source, &options);
    check_node_budget(root, limits)?;
    author_html::strip_author_markers(root);
    let blocks = if include_blocks {
        let line_starts = LineIndex::new(source);
        blocks_from_root(root, source, &line_starts)
    } else {
        Vec::new()
    };
    let task_indices: HashMap<_, _> = root
        .descendants()
        .filter(|node| matches!(node.data().value, NodeValue::TaskItem(_)))
        .map(|node| node.data().sourcepos.to_string())
        .enumerate()
        .map(|(index, sourcepos)| (sourcepos, index))
        .collect();
    let mut writer = BoundedWriter::new(limits.max_html_bytes);
    if comrak::format_html_with_plugins(root, &options, &mut writer, &plugins).is_err()
        || writer.exceeded
    {
        return Err(html_limit_error(limits));
    }
    let sanitized = sanitize(&writer.output, allow_remote_images);
    images::account_images(&sanitized, limits)?;
    let html = patch_task_items(&harden_images(&sanitized), &task_indices);
    if html.len() > limits.max_html_bytes {
        return Err(html_limit_error(limits));
    }
    Ok((html, blocks))
}

fn html_limit_error(limits: &RenderLimits) -> PreviewLimitError {
    PreviewLimitError::new(
        PreviewLimitKind::HtmlBytes,
        format!(
            "This document's preview HTML exceeds the {} MiB limit.",
            limits.max_html_bytes / limits::MIB
        ),
    )
}

/// Diagnostic markup for a preview budget failure. The source itself is never
/// altered; this only replaces the stale preview with an explicit state.
pub fn preview_limit_html(error: &PreviewLimitError) -> String {
    format!(
        "<div class=\"preview-limit\" data-preview-limit=\"{}\" role=\"status\"><p class=\"preview-limit-title\">Preview unavailable</p><p class=\"preview-limit-message\">{}</p><p class=\"preview-limit-source-note\">The document source is unchanged and can still be edited and saved.</p></div>",
        error.kind.as_str(),
        escape_html(&error.message)
    )
}

fn escape_html(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&#39;"),
            _ => escaped.push(character),
        }
    }
    escaped
}

/// Enforce the generated-HTML budget while Comrak is writing, rather than only
/// measuring an already-allocated multi-megabyte string afterwards.
struct BoundedWriter {
    output: String,
    limit: usize,
    exceeded: bool,
}

impl BoundedWriter {
    fn new(limit: usize) -> Self {
        Self {
            output: String::with_capacity(limit.min(64 * 1024)),
            limit,
            exceeded: false,
        }
    }
}

impl fmt::Write for BoundedWriter {
    fn write_str(&mut self, value: &str) -> fmt::Result {
        if self.output.len().saturating_add(value.len()) > self.limit {
            self.exceeded = true;
            return Err(fmt::Error);
        }
        self.output.push_str(value);
        Ok(())
    }
}

/// Images inside a document must not disclose the app origin or the user's
/// reading activity to third-party hosts.
fn harden_images(html: &str) -> String {
    html.replace("<img ", "<img referrerpolicy=\"no-referrer\" ")
}

fn is_finite_number(value: &str) -> bool {
    matches!(value.trim().parse::<f64>(), Ok(number) if number.is_finite())
}

fn sanitize(html: &str, allow_remote_images: bool) -> String {
    sanitizer_builder(allow_remote_images)
        .clean(html)
        .to_string()
}

fn sanitizer_builder(allow_remote_images: bool) -> ammonia::Builder<'static> {
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
        .add_tags(["section", "input", "progress", "meter"])
        .add_tag_attributes("input", ["type", "checked", "disabled"])
        .add_tag_attributes("progress", ["value", "max"])
        .add_tag_attributes("meter", ["value", "min", "max", "low", "high", "optimum"])
        .add_tag_attributes("section", ["data-footnotes"])
        .add_tag_attributes("th", ["style"])
        .add_tag_attributes("td", ["style"])
        .url_schemes(HashSet::from(["https", "http", "mailto", "data"]))
        .attribute_filter(move |element, attribute, value| {
            match attribute {
                // A progress/meter value must be a finite number; anything else
                // is dropped rather than guessed, in both reading and editing.
                "value" | "max" | "min" | "low" | "high" | "optimum"
                    if (element == "progress" || element == "meter")
                        && !is_finite_number(value) =>
                {
                    None
                }
                // Raw HTML can bypass the Markdown image rewriter; apply the same
                // remote-image preference to author-supplied `<img src>` values.
                "src" if remote_image_url(value) => {
                    if allow_remote_images {
                        Some(Cow::Borrowed(value))
                    } else {
                        Some(Cow::Owned(BLOCKED_REMOTE_IMAGE.to_string()))
                    }
                }
                "href" if is_data_url(value) => None,
                "id" if !value.starts_with("doc-") => Some(Cow::Owned(format!("doc-{value}"))),
                "id" => Some(Cow::Borrowed(value)),
                "href" if value.starts_with('#') => {
                    Some(Cow::Owned(format!("#doc-{}", &value[1..])))
                }
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
            }
        })
        .link_rel(Some("noopener noreferrer"));
    sanitizer
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

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
    fn slash_and_case_forged_source_positions_cannot_steal_a_real_task_index() {
        // The real task lives on line 6, so a forged marker can name the exact
        // same source position. Without normalization, the raw checkbox wins
        // the task-index lookup and the real task loses its toggle.
        let variants = [
            "<ul>\n<li/data-sourcepos=\"FORGED\"><input type=\"checkbox\" disabled></li>\n</ul>\n\n\n- [x] Real task\n",
            "<ul>\n<LI/DATA-SOURCEPOS=\"FORGED\"><input type=\"checkbox\" disabled></LI>\n</ul>\n\n\n- [x] Real task\n",
            "<ul>\n<li\nDaTa-SoUrCePoS=\"FORGED\"><input type=\"checkbox\" disabled></li>\n</ul>\n\n\n- [x] Real task\n",
        ];
        for template in variants {
            let options = markdown_options();
            let arena = Arena::new();
            let root = parse_document(&arena, template, &options);
            let sourcepos = root
                .descendants()
                .find(|node| matches!(node.data().value, NodeValue::TaskItem(_)))
                .unwrap()
                .data()
                .sourcepos
                .to_string();
            let source = template.replace("FORGED", &sourcepos);
            let rendered = render(&source, None);
            assert_eq!(
                rendered.matches("data-task-index=").count(),
                1,
                "{template:?} produced forged task indices: {rendered}"
            );
            assert!(
                rendered.contains("<li><input type=\"checkbox\" disabled=\"\"></li>"),
                "raw HTML must lose its generated-looking marker: {rendered}"
            );
            assert!(
                rendered.contains(&format!(
                    "<li data-sourcepos=\"{sourcepos}\"><input type=\"checkbox\" data-task-index=\"0\""
                )),
                "the real task must keep index zero: {rendered}"
            );
            assert_eq!(
                set_task_checked(&source, 0, false),
                source.replace("- [x] Real task", "- [ ] Real task"),
                "toggling index zero must change only the real Markdown task"
            );
        }

        let forged_div = render("<div DATA-SOURCEPOS=\"9:1-9:9\">forged</div>", None);
        assert!(
            !forged_div.to_ascii_lowercase().contains("data-sourcepos"),
            "forged div markers must be removed too: {forged_div}"
        );
    }

    #[test]
    fn author_html_keeps_only_checkbox_inputs() {
        let rendered = render(
            "<input type=\"text\" value=\"typed\">\n\n<input type=\"radio\">\n\n<input>\n\n<input type=\"CheckBox\" checked>\n\n- [x] Real task\n",
            None,
        );
        assert!(!rendered.contains("type=\"text\""), "{rendered}");
        assert!(!rendered.contains("value=\"typed\""), "{rendered}");
        assert!(!rendered.contains("type=\"radio\""), "{rendered}");
        assert!(
            rendered.contains("<input type=\"checkbox\" checked=\"\">"),
            "the author checkbox must survive without a forged task index: {rendered}"
        );
        assert_eq!(
            rendered.matches("data-task-index=").count(),
            1,
            "{rendered}"
        );
    }

    #[test]
    fn raw_html_cannot_spoof_task_source_positions() {
        // Attribute names are case-insensitive in HTML; the stripper must not be.
        let spoofed = concat!(
            "<ul>\n",
            "<li DaTa-SoUrCePoS=\"SOURCEPOS\"><input type=\"checkbox\" disabled=\"\"></li>\n",
            "<li><input type=\"checkbox\" data-task-index=\"0\"></li>\n",
            "</ul>\n\n",
            "- [x] Real task\n",
        );
        let options = markdown_options();
        let arena = Arena::new();
        let root = parse_document(&arena, spoofed, &options);
        let sourcepos = root
            .descendants()
            .find(|node| matches!(node.data().value, NodeValue::TaskItem(_)))
            .unwrap()
            .data()
            .sourcepos
            .to_string();
        let rendered = render(&spoofed.replace("SOURCEPOS", &sourcepos), None);
        assert_eq!(
            rendered.matches("data-task-index=").count(),
            1,
            "{rendered}"
        );
        assert!(
            rendered.contains("<ul>\n<li><input type=\"checkbox\" disabled=\"\"></li>"),
            "raw HTML must lose a mixed-case data-sourcepos attribute: {rendered}"
        );
        assert!(
            rendered.contains(&format!(
                "<li data-sourcepos=\"{sourcepos}\"><input type=\"checkbox\" data-task-index=\"0\""
            )),
            "{rendered}"
        );
    }

    #[test]
    fn remote_images_follow_the_privacy_preference() {
        let directory = tempfile::tempdir().unwrap();
        let source = "![tracking pixel](https://example.com/pixel.png)";
        let blocked = render_with_blocks(source, Some(directory.path()), false).0;
        assert!(blocked.contains("data:image/svg+xml;base64,"), "{blocked}");
        assert!(!blocked.contains("example.com"), "{blocked}");
        assert!(blocked.contains("referrerpolicy=\"no-referrer\""));

        let allowed = render_with_blocks(source, Some(directory.path()), true).0;
        assert!(allowed.contains("src=\"https://example.com/pixel.png\""));
        assert!(allowed.contains("referrerpolicy=\"no-referrer\""));

        let raw_blocked = render("<img src=\"https://example.com/raw.png\">", None);
        assert!(raw_blocked.contains("data:image/svg+xml;base64,"));
        assert!(!raw_blocked.contains("example.com"), "{raw_blocked}");
        let spaced = render("<img src=\"  https://example.com/spaced.png\">", None);
        assert!(!spaced.contains("example.com"), "{spaced}");
        let (raw_allowed, _) =
            render_with_blocks("<img src=\"https://example.com/raw.png\">", None, true);
        assert!(raw_allowed.contains("https://example.com/raw.png"));
    }

    #[test]
    fn obfuscated_remote_image_urls_are_blocked_too() {
        // Every form a browser's URL parser resolves to an HTTP(S) request must
        // honour the preference, not just the canonical `https://` prefix.
        let forms = [
            "https://example.com/a.png",
            "HTTPS://example.com/b.png",
            "http://example.com/c.png",
            "https:example.com/d.png",
            "https:/example.com/e.png",
            "https:\\example.com\\f.png",
            "//example.com/g.png",
            " ht\ntps://example.com/i.png",
        ];
        for form in forms {
            let raw = format!("<img src=\"{form}\">");
            let blocked = render(&raw, None);
            assert!(
                !blocked.contains("example.com"),
                "raw HTML {form:?} was not blocked: {blocked}"
            );
            assert!(
                blocked.contains("data:image/svg+xml;base64,"),
                "raw HTML {form:?} did not show the placeholder: {blocked}"
            );
            let allowed = render_with_blocks(&raw, None, true).0;
            assert!(
                !allowed.contains("data:image/svg+xml;base64,"),
                "raw HTML {form:?} stayed blocked when enabled: {allowed}"
            );
        }
        for form in ["HTTPS://example.com/a.png", "https:example.com/b.png"] {
            let markdown = format!("![x]({form})");
            let blocked = render(&markdown, None);
            assert!(
                !blocked.contains("example.com"),
                "Markdown {form:?} was not blocked: {blocked}"
            );
            assert!(
                blocked.contains("data:image/svg+xml;base64,"),
                "Markdown {form:?} did not show the placeholder: {blocked}"
            );
        }
    }

    #[test]
    fn data_url_links_are_removed_but_data_images_remain_available() {
        let rendered = render(
            "[click](data:text/html,boom)\n\n<img src=\"data:image/png;base64,AAAA\">",
            None,
        );
        assert!(!rendered.contains("data:text/html"), "{rendered}");
        assert!(
            rendered.contains("data:image/png;base64,AAAA"),
            "{rendered}"
        );
        assert!(rendered.contains("referrerpolicy=\"no-referrer\""));
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
        assert!(
            !rendered.contains("#doc-doc-"),
            "author HTML and generated markup must not double-prefix ids: {rendered}"
        );
    }

    #[test]
    fn raw_html_fragment_links_are_prefixed_exactly_once() {
        let rendered = render(
            "# Title\n\n<a href=\"#title\">raw jump</a>\n\n<div id=\"section\">Text</div>\n",
            None,
        );
        assert!(rendered.contains("href=\"#doc-title\""), "{rendered}");
        assert!(rendered.contains("id=\"doc-section\""), "{rendered}");
        assert!(!rendered.contains("#doc-doc-"), "{rendered}");
        assert!(!rendered.contains("id=\"doc-doc-section\""), "{rendered}");
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
    fn bracket_tex_delimiters_render_as_math() {
        let rendered = render(
            "Inline \\(a+b\\) and display:\n\n\\[\nz^2\n\\]\n\n```\n\\(not math\\)\n```\n\nCode `\\(also code\\)`.\n",
            None,
        );
        assert!(
            rendered.contains("data-math-style=\"inline\""),
            "{rendered}"
        );
        assert!(rendered.contains(">a+b<"), "{rendered}");
        assert!(
            rendered.contains("data-math-style=\"display\""),
            "{rendered}"
        );
        assert!(rendered.contains("z^2"), "{rendered}");
        assert!(rendered.contains("\\(not math\\)"), "{rendered}");
        assert!(rendered.contains("\\(also code\\)"), "{rendered}");
    }

    #[test]
    fn bracket_math_edit_blocks_keep_math_nodes() {
        let source = "Inline \\(x\\) and:\n\n\\[\ny\n\\]\n";
        let blocks = edit_blocks(source);
        let nodes: Vec<_> = blocks.iter().flat_map(|block| &block.nodes).collect();
        let math: Vec<_> = nodes.iter().filter(|node| node.kind == "math").collect();
        assert_eq!(math.len(), 2, "{nodes:?}");
        assert_eq!(math[0].text.as_deref(), Some("x"));
        assert_eq!(&source[math[0].start..math[0].end], "\\(x\\)");
        assert_eq!(math[1].text.as_deref(), Some("\ny\n"));
        assert_eq!(&source[math[1].start..math[1].end], "\\[\ny\n\\]");
    }

    #[test]
    fn indented_code_that_looks_like_a_fence_does_not_hide_later_math() {
        let cases = [
            (
                "    ```\n    \\(backtick code\\)\n\nInline \\(x\\) after.\n",
                ">x<",
                "\\(backtick code\\)",
            ),
            (
                "    ~~~\n    \\(tilde code\\)\n\nInline \\(y\\) after.\n",
                ">y<",
                "\\(tilde code\\)",
            ),
            (
                "\t```\n\t\\(tab code\\)\n\nInline \\(z\\) after.\n",
                ">z<",
                "\\(tab code\\)",
            ),
        ];
        for (source, expected_math, code_text) in cases {
            let rendered = render(source, None);
            assert!(
                rendered.contains("data-math-style=\"inline\""),
                "later inline math was not normalized for {source:?}: {rendered}"
            );
            assert!(
                rendered.contains(expected_math),
                "normalized math content missing for {source:?}: {rendered}"
            );
            assert!(
                rendered.contains(code_text),
                "indented code was rewritten as math for {source:?}: {rendered}"
            );
        }
    }

    #[test]
    fn multiline_code_spans_keep_bracket_tex_literal() {
        let rendered = render(
            "A `code\nspan \\(not math\\)` stays code.\n\nInline \\(x\\) works.\n",
            None,
        );
        assert!(
            rendered.contains("\\(not math\\)"),
            "multiline code span content was rewritten: {rendered}"
        );
        assert!(!rendered.contains("$not math$"), "{rendered}");
        assert!(
            rendered.contains("data-math-style=\"inline\""),
            "later inline math was not normalized: {rendered}"
        );
        assert!(rendered.contains(">x<"), "{rendered}");
    }

    #[test]
    fn block_math_lookahead_ignores_closers_inside_fences() {
        let rendered = render("\\[\n\n```\n\\]\n```\n\nInline \\(x\\) works.\n", None);
        assert!(
            !rendered.contains("data-math-style=\"display\""),
            "fenced code closed block math: {rendered}"
        );
        assert!(
            rendered.contains("\\]"),
            "fenced code content changed: {rendered}"
        );
        assert!(
            rendered.contains("data-math-style=\"inline\""),
            "later inline math was not normalized: {rendered}"
        );
        assert!(rendered.contains(">x<"), "{rendered}");
    }

    #[test]
    fn block_math_lookahead_ignores_indented_code_closers() {
        let rendered = render("\\[\n\n    \\]\n\nInline \\(x\\) works.\n", None);
        assert!(
            !rendered.contains("data-math-style=\"display\""),
            "indented code closed block math: {rendered}"
        );
        assert!(
            rendered.contains("\\]"),
            "indented code content changed: {rendered}"
        );
        assert!(
            rendered.contains("data-math-style=\"inline\""),
            "later inline math was not normalized: {rendered}"
        );
        assert!(rendered.contains(">x<"), "{rendered}");
    }

    #[test]
    fn quoted_and_list_fences_keep_bracket_tex_literal() {
        let cases = [
            (
                "> ```\n> \\(quoted code\\)\n> ```\n\nInline \\(x\\) works.\n",
                "\\(quoted code\\)",
            ),
            (
                "- ```\n  \\(list code\\)\n  ```\n\nInline \\(y\\) works.\n",
                "\\(list code\\)",
            ),
        ];
        for (source, code_text) in cases {
            let rendered = render(source, None);
            assert!(
                rendered.contains(code_text),
                "fenced code content was rewritten: {rendered}"
            );
            assert!(
                !rendered.contains("$quoted code$") && !rendered.contains("$list code$"),
                "fenced code content became math: {rendered}"
            );
            assert!(
                rendered.contains("data-math-style=\"inline\""),
                "later inline math was not normalized: {rendered}"
            );
        }
    }

    #[test]
    fn raw_html_pre_keeps_bracket_tex_literal() {
        let rendered = render(
            "<pre>\n\\(pre text\\)\n\\[pre display\\]\n</pre>\n\nInline \\(x\\) works.\n",
            None,
        );
        assert!(
            rendered.contains("\\(pre text\\)"),
            "raw HTML pre content was rewritten: {rendered}"
        );
        assert!(
            rendered.contains("\\[pre display\\]"),
            "raw HTML pre display content was rewritten: {rendered}"
        );
        assert!(
            rendered.contains("data-math-style=\"inline\""),
            "later inline math was not normalized: {rendered}"
        );
        assert!(rendered.contains(">x<"), "{rendered}");
    }

    #[test]
    fn many_unclosed_block_math_openers_hit_math_complexity_budget() {
        let mut source = "\\[\n".repeat(10_000);
        source.push_str("\nInline \\(x\\) works.\n");
        let started = std::time::Instant::now();
        let rendered = render(&source, None);
        let elapsed = started.elapsed();
        assert!(
            rendered.contains("data-preview-limit=\"math_complexity\""),
            "expected a bounded math diagnostic: {rendered}"
        );
        assert!(!rendered.contains("data-math-style"), "{rendered}");
        assert!(
            elapsed < std::time::Duration::from_secs(1),
            "adversarial block math was not bounded: took {elapsed:?}"
        );
    }

    #[test]
    fn many_unmatched_inline_openers_hit_math_complexity_budget() {
        let mut source = "\\(".repeat(20_000);
        source.push_str(" text\n\nInline \\(x\\) works.\n");
        let started = std::time::Instant::now();
        let rendered = render(&source, None);
        let elapsed = started.elapsed();
        assert!(
            rendered.contains("data-preview-limit=\"math_complexity\""),
            "expected a bounded math diagnostic: {rendered}"
        );
        assert!(!rendered.contains("data-math-style"), "{rendered}");
        assert!(
            elapsed < std::time::Duration::from_secs(1),
            "adversarial inline math was not bounded: took {elapsed:?}"
        );
    }

    #[test]
    fn many_unmatched_code_math_openers_hit_math_complexity_budget() {
        let source = "$`a ".repeat(5_000);
        let started = std::time::Instant::now();
        let rendered = render(&source, None);
        let elapsed = started.elapsed();
        assert!(
            rendered.contains("data-preview-limit=\"math_complexity\""),
            "expected a bounded code-math diagnostic: {rendered}"
        );
        assert!(!rendered.contains("data-math-style"), "{rendered}");
        assert!(
            elapsed < std::time::Duration::from_secs(1),
            "adversarial code math was not bounded: took {elapsed:?}"
        );
    }

    #[test]
    fn valid_latex_math_stays_below_the_budget() {
        let mut source = String::new();
        for index in 0..2_000 {
            source.push_str("x \\(a");
            source.push_str(&index.to_string());
            source.push_str("\\) ");
        }
        let rendered = render(&source, None);
        assert!(
            !rendered.contains("data-preview-limit"),
            "ordinary math was rejected: {rendered}"
        );
        assert!(
            rendered.contains("data-math-style=\"inline\""),
            "ordinary inline math did not render: {rendered}"
        );
    }

    #[test]
    fn literal_code_with_delimiters_is_conservatively_budgeted() {
        let small = render("```text\n\\(literal, not math\n```\n", None);
        assert!(
            !small.contains("data-preview-limit"),
            "a small code block must not hit the math budget: {small}"
        );
        assert!(small.contains("\\(literal, not math"), "{small}");

        // The budget runs before parsing, so it cannot know these unmatched
        // openers are inside a code fence. This is the documented conservative
        // false positive: a pathological code-only document is rejected rather
        // than risking Comrak's quadratic scanner.
        let mut source = String::from("```text\n");
        source.push_str(&"\\(literal\n".repeat(20_000));
        source.push_str("```\n");
        let rendered = render(&source, None);
        assert!(
            rendered.contains("data-preview-limit=\"math_complexity\""),
            "expected the conservative code-only budget diagnostic: {rendered}"
        );
    }

    #[test]
    fn native_latex_escaped_backslash_differs_from_the_rich_model() {
        // Comrak closes at the second backslash of `\\)` because its scanner
        // does not skip escaped slashes. The rich editor's JS tokenizer skips
        // the pair and closes at the final `\)`. Preview/export follow Comrak;
        // this is a known grammar divergence, not exact editor parity.
        let rendered = render("Inline \\(a\\\\) + b\\) tail.\n", None);
        assert!(
            rendered.contains(">a\\</span>"),
            "native preview should close at the escaped-backslash pair: {rendered}"
        );
        assert!(rendered.contains("+ b) tail."), "{rendered}");
    }

    #[test]
    fn native_latex_allows_multiline_inline_math_despite_rich_model() {
        // Comrak's native inline math may cross a soft line break; the rich
        // editor's JS tokenizer rejects newlines. Preview/export follow Comrak.
        let rendered = render("Inline \\(a\n+b\\) tail.\n", None);
        assert!(
            rendered.contains(">a\n+b</span>"),
            "native preview should keep the multiline math span: {rendered}"
        );
    }

    #[test]
    fn unmatched_latex_delimiters_render_literally() {
        let rendered = render("\\(a + b and \\[c + d\n", None);
        assert!(!rendered.contains("data-math-style"), "{rendered}");
        assert!(rendered.contains("(a + b"), "{rendered}");
        assert!(rendered.contains("[c + d"), "{rendered}");
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

    /// Escape a filesystem path for an angle-bracketed CommonMark link
    /// destination. On Windows the path contains backslashes, and CommonMark
    /// consumes a backslash before ASCII punctuation. The `\.tmp` segment that
    /// `tempfile` creates would otherwise become `.tmp` after parsing, so the
    /// image would name a path that does not exist. Escaping backslashes (and
    /// the angle-bracket delimiters) round-trips the exact path.
    fn markdown_image_destination(path: &Path) -> String {
        let path = path.to_string_lossy();
        let mut escaped = String::with_capacity(path.len());
        for character in path.chars() {
            if matches!(character, '\\' | '<' | '>') {
                escaped.push('\\');
            }
            escaped.push(character);
        }
        escaped
    }

    #[test]
    fn markdown_image_fixture_preserves_windows_style_absolute_paths() {
        // This literal path is parsed the same way on every host: the parser
        // does not know about the host filesystem. It reproduces the Windows
        // temp-path shape, including the `tempfile` `.tmp` prefix.
        let path = Path::new(r"C:\Users\runneradmin\AppData\Local\Temp\.tmpAbC123\notes\image.png");
        let destination = markdown_image_destination(path);
        let source = format!("![image](<{destination}>)");
        let arena = Arena::new();
        let root = parse_document(&arena, &source, &markdown_options());
        let parsed = root
            .descendants()
            .find_map(|node| match &node.data().value {
                NodeValue::Image(link) => Some(link.url.clone()),
                _ => None,
            });
        assert_eq!(parsed.as_deref(), path.to_str());
    }

    #[test]
    fn local_images_cannot_escape_document_directory() {
        let directory = tempfile::tempdir().unwrap();
        let base = directory.path().join("notes");
        fs::create_dir(&base).unwrap();
        fs::write(base.join("image.png"), b"image").unwrap();
        fs::write(directory.path().join("secret.png"), b"secret").unwrap();
        assert!(local_image("image.png", Some(&base), false)
            .unwrap()
            .starts_with("data:image/png;base64,"));
        let absolute_image = base.join("image.png");
        let absolute = absolute_image.to_string_lossy();
        assert!(local_image(&absolute, Some(&base), false)
            .unwrap()
            .starts_with("data:image/png;base64,"));
        let destination = markdown_image_destination(&absolute_image);
        let (rendered, _) =
            render_with_blocks(&format!("![image](<{destination}>)"), Some(&base), false);
        assert!(rendered.contains("data:image/png;base64,"), "{rendered}");
        assert!(local_image(
            &directory.path().join("secret.png").to_string_lossy(),
            Some(&base),
            false
        )
        .is_none());
        assert!(local_image("../secret.png", Some(&base), false).is_none());
        assert!(local_image("%2e%2e/secret.png", Some(&base), false).is_none());
        assert_eq!(
            local_image("https://example.com/pixel.png", Some(&base), false),
            Some(BLOCKED_REMOTE_IMAGE.to_string())
        );
        assert_eq!(
            local_image("https://example.com/pixel.png", Some(&base), true),
            Some("https://example.com/pixel.png".to_string())
        );
    }

    #[test]
    fn source_map_handles_empty_last_line_unicode_crlf_and_nested_lists() {
        assert!(edit_blocks("").is_empty());

        let no_newline = "last line without a newline";
        let blocks = edit_blocks(no_newline);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].start, 0);
        assert_eq!(blocks[0].end, no_newline.len());
        assert_eq!(blocks[0].source, no_newline);

        let source = "# Café \u{1f600}\n\nA **bold café** end\n";
        let blocks = edit_blocks(source);
        let nodes: Vec<_> = blocks.iter().flat_map(|block| &block.nodes).collect();
        let bold = nodes
            .iter()
            .find(|node| node.text.as_deref() == Some("bold café"))
            .expect("multibyte inline text must map to a source range");
        assert_eq!(&source[bold.start..bold.end], "bold café");
        let heading = nodes
            .iter()
            .find(|node| node.kind == "heading")
            .expect("heading with an emoji must map to a source range");
        assert_eq!(&source[heading.start..heading.end], "# Café \u{1f600}");

        let crlf_normalized = "first\r\n\r\n- [ ] task\r\n".replace("\r\n", "\n");
        let blocks = edit_blocks(&crlf_normalized);
        assert_eq!(blocks[0].source, "first");
        assert!(blocks[1].source.contains("- [ ] task"));
        assert!(blocks
            .iter()
            .flat_map(|block| &block.nodes)
            .all(|node| crlf_normalized.is_char_boundary(node.start)
                && crlf_normalized.is_char_boundary(node.end)));

        let nested = "- outer\n  - inner\n\nAfter\n";
        let blocks = edit_blocks(nested);
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].source, "- outer\n  - inner");
        assert_eq!(blocks[1].source, "After");
        assert!(blocks[0].nodes.iter().any(|node| node.kind == "item"));
        assert!(blocks[0]
            .nodes
            .iter()
            .all(|node| nested.is_char_boundary(node.start) && nested.is_char_boundary(node.end)));
    }

    #[test]
    fn structural_budgets_fail_before_expensive_parsing() {
        let line_limits = RenderLimits {
            max_lines: 2,
            ..DEFAULT_RENDER_LIMITS
        };
        assert_eq!(
            render_with_blocks_checked("a\nb\nc", None, false, &line_limits, true)
                .unwrap_err()
                .kind,
            PreviewLimitKind::Lines
        );

        for source in [
            "> > > deep",
            "- > > > deep",
            "1. > > > deep",
            "- item\n    > > > list-indented deep",
        ] {
            let depth_limits = RenderLimits {
                max_blockquote_depth: 2,
                ..DEFAULT_RENDER_LIMITS
            };
            assert_eq!(
                render_with_blocks_checked(source, None, false, &depth_limits, true)
                    .unwrap_err()
                    .kind,
                PreviewLimitKind::BlockquoteDepth,
                "{source:?} must fail the cheap depth check"
            );
        }

        let budget = RenderLimits {
            max_ast_nodes: 1,
            ..DEFAULT_RENDER_LIMITS
        };
        assert_eq!(
            render_with_blocks_checked("a", None, false, &budget, true)
                .unwrap_err()
                .kind,
            PreviewLimitKind::AstNodes
        );

        let html_budget = RenderLimits {
            max_html_bytes: 16,
            ..DEFAULT_RENDER_LIMITS
        };
        assert_eq!(
            render_with_blocks_checked("# heading\n\nbody", None, false, &html_budget, true)
                .unwrap_err()
                .kind,
            PreviewLimitKind::HtmlBytes
        );

        let source_bytes = RenderLimits {
            max_source_bytes: 4,
            ..DEFAULT_RENDER_LIMITS
        };
        assert_eq!(
            render_with_blocks_checked("too long", None, false, &source_bytes, true)
                .unwrap_err()
                .kind,
            PreviewLimitKind::SourceBytes
        );
    }

    #[test]
    fn preview_check_reports_structural_budget_failures_cheaply() {
        let tight = RenderLimits {
            max_ast_nodes: 2,
            ..DEFAULT_RENDER_LIMITS
        };
        let error = preview_check("# heading\n\nA paragraph with **bold** text.", &tight)
            .expect("a document over the node budget must be reported");
        assert_eq!(error.kind, PreviewLimitKind::AstNodes);

        assert_eq!(
            preview_check("# heading\n\nA small paragraph.", &DEFAULT_RENDER_LIMITS),
            None,
            "a small document under the default limits must pass"
        );
    }

    #[test]
    fn render_with_blocks_checked_can_skip_edit_blocks() {
        let (html, blocks) = render_with_blocks_checked(
            "# Heading\n\nBody",
            None,
            false,
            &DEFAULT_RENDER_LIMITS,
            false,
        )
        .unwrap();
        assert!(!html.is_empty());
        assert!(
            blocks.is_empty(),
            "the no-blocks path must not build edit blocks"
        );

        let (_, blocks) = render_with_blocks_checked(
            "# Heading\n\nBody",
            None,
            false,
            &DEFAULT_RENDER_LIMITS,
            true,
        )
        .unwrap();
        assert!(
            !blocks.is_empty(),
            "explicitly requesting blocks must still build them"
        );
    }

    #[test]
    fn preview_limit_failures_keep_source_and_expose_a_clear_diagnostic() {
        let source = "a\nb\nc";
        let original = source.to_owned();
        let limits = RenderLimits {
            max_lines: 2,
            ..DEFAULT_RENDER_LIMITS
        };
        let error = render_with_blocks_checked(source, None, false, &limits, true).unwrap_err();
        assert_eq!(source, original, "the source must never be rewritten");
        let html = preview_limit_html(&error);
        assert!(html.contains("data-preview-limit=\"lines\""), "{html}");
        assert!(html.contains("Preview unavailable"), "{html}");
        assert!(html.contains("source is unchanged"), "{html}");

        let task_source = "> > > deep\n\n- [ ] task";
        let depth_limits = RenderLimits {
            max_blockquote_depth: 2,
            ..DEFAULT_RENDER_LIMITS
        };
        assert_eq!(
            set_task_checked_with_limits(task_source, 0, true, &depth_limits),
            task_source,
            "task parsing must apply the same structural preflight"
        );

        let node_limits = RenderLimits {
            max_ast_nodes: 1,
            ..DEFAULT_RENDER_LIMITS
        };
        assert_eq!(
            set_task_checked_with_limits("- [ ] task", 0, true, &node_limits),
            "- [ ] task"
        );
    }

    #[test]
    fn progress_and_meter_render_with_numeric_attributes_only() {
        let rendered = render(
            "Progress: <progress value=\"72\" max=\"100\"> 72% </progress>\n\nMeter: <meter min=\"0\" max=\"100\" value=\"64\"> 64% </meter>",
            None,
        );
        assert!(rendered.contains("<progress"), "{rendered}");
        assert!(rendered.contains("value=\"72\""), "{rendered}");
        assert!(rendered.contains("max=\"100\""), "{rendered}");
        assert!(rendered.contains("<meter"), "{rendered}");
        assert!(rendered.contains("value=\"64\""), "{rendered}");
        assert!(
            !rendered.contains("onclick"),
            "event handlers must stay dropped: {rendered}"
        );

        let rejected = render(
            "Bad: <progress value=\"oops\" max=\"100\">x</progress>",
            None,
        );
        assert!(
            !rejected.contains("value=\"oops\""),
            "a non-numeric value must be dropped: {rejected}"
        );
        assert!(
            rejected.contains("<progress"),
            "the element itself must survive: {rejected}"
        );
    }

    #[test]
    fn inline_and_container_html_keep_their_start_and_end_boundaries() {
        let inline = render("a <kbd>Ctrl</kbd> b", None);
        assert!(
            inline.contains("a <kbd>Ctrl</kbd> b"),
            "an inline start tag must not be auto-closed: {inline}"
        );

        let container = render(
            "<details>\n<summary>More</summary>\n\nInside\n\n</details>",
            None,
        );
        assert!(container.contains("<details>"), "{container}");
        assert!(
            container.contains("<summary>More</summary>"),
            "summary content must stay inside its element: {container}"
        );
        assert!(
            !container.contains("<details></details>"),
            "opening details must not be auto-closed: {container}"
        );
        assert!(container.contains("</details>"), "{container}");
    }

    #[test]
    fn backslash_remote_image_authorities_are_blocked() {
        for form in ["\\\\host\\x.png", "/\\\\host/x.png", "\\\\/host/x.png"] {
            let raw = format!("<img src=\"{form}\">");
            let blocked = render(&raw, None);
            assert!(
                !blocked.contains("host"),
                "raw HTML {form:?} leaked a host: {blocked}"
            );
            assert!(
                blocked.contains(BLOCKED_REMOTE_IMAGE),
                "raw HTML {form:?} must use the blocked placeholder: {blocked}"
            );
        }
    }

    #[test]
    fn encoded_data_scheme_hrefs_are_removed() {
        for form in [
            "data&#10;:text/html,boom",
            "data&#9;:text/html,boom",
            "data&#13;:text/html,boom",
        ] {
            let raw = format!("<a href=\"{form}\">click</a>");
            let rendered = render(&raw, None);
            assert!(
                !rendered.contains("text/html") && !rendered.contains("boom"),
                "raw href {form:?} kept a data: URL: {rendered}"
            );
        }
    }

    #[test]
    fn raw_html_images_share_the_markdown_image_budget() {
        let limits = RenderLimits {
            max_image_occurrences: 200,
            ..DEFAULT_RENDER_LIMITS
        };
        let image = "data:image/png;base64,AAAA";
        let source = (0..201)
            .map(|index| format!("<img src=\"{image}\" alt=\"{index}\">"))
            .collect::<Vec<_>>()
            .join("\n\n");
        assert_eq!(
            render_with_blocks_checked(&source, None, false, &limits, true)
                .unwrap_err()
                .kind,
            PreviewLimitKind::ImageOccurrences,
            "raw HTML images must count toward the same occurrence budget"
        );

        let bytes_limits = RenderLimits {
            max_encoded_image_bytes: image.len() * 2,
            ..DEFAULT_RENDER_LIMITS
        };
        let over_bytes =
            format!("<img src=\"{image}\">\n\n<img src=\"{image}\">\n\n<img src=\"{image}\">");
        assert_eq!(
            render_with_blocks_checked(&over_bytes, None, false, &bytes_limits, true)
                .unwrap_err()
                .kind,
            PreviewLimitKind::ImageBytes,
            "raw HTML data images must count toward the encoded byte budget"
        );
    }

    #[test]
    fn contained_fences_stop_when_their_container_ends() {
        let deep = "> ".repeat(DEFAULT_RENDER_LIMITS.max_blockquote_depth + 1);
        for source in [
            format!("> ```\noutside\n\n{deep}\n"),
            format!("- ```\noutside\n\n{deep}\n"),
        ] {
            let rendered = render(&source, None);
            assert!(
                rendered.contains("data-preview-limit=\"blockquote_depth\""),
                "a contained fence must not swallow later real blockquotes: {rendered}"
            );
        }

        let ten_thousand = "> ".repeat(10_000);
        for source in [
            format!("> ```\noutside\n\n{ten_thousand}\n"),
            format!("- ```\noutside\n\n{ten_thousand}\n"),
        ] {
            assert_eq!(
                preflight(&source, &DEFAULT_RENDER_LIMITS).unwrap_err().kind,
                PreviewLimitKind::BlockquoteDepth,
                "deep blockquotes after an ended contained fence must be rejected cheaply"
            );
        }
    }

    #[test]
    fn list_fences_honor_list_content_indentation() {
        let content = "> ".repeat(DEFAULT_RENDER_LIMITS.max_blockquote_depth + 1);
        for source in [
            format!("- item\n\n    ```text\n    {content}\n    ```\n"),
            format!("- outer\n  - inner\n\n    ```text\n    {content}\n    ```\n"),
        ] {
            let rendered = render(&source, None);
            assert!(
                !rendered.contains("data-preview-limit=\"blockquote_depth\""),
                "a correctly indented list fence is valid code: {rendered}"
            );
            assert!(rendered.contains("<pre"), "{rendered}");
        }
    }

    #[test]
    fn top_level_unclosed_fence_keeps_running_to_eof() {
        let content = "> ".repeat(DEFAULT_RENDER_LIMITS.max_blockquote_depth + 1);
        let rendered = render(&format!("```\n{content}\n"), None);
        assert!(
            !rendered.contains("data-preview-limit=\"blockquote_depth\""),
            "an unclosed top-level fence is literal code through EOF: {rendered}"
        );
    }

    #[test]
    fn fenced_code_is_not_mistaken_for_deep_blockquotes() {
        let content = "> ".repeat(DEFAULT_RENDER_LIMITS.max_blockquote_depth + 1);
        for source in [
            format!("```\n{content}\n```\n"),
            format!("> ```\n> {content}\n> ```\n"),
            format!("- ```\n  {content}\n  ```\n"),
        ] {
            let rendered = render(&source, None);
            assert!(
                !rendered.contains("data-preview-limit=\"blockquote_depth\""),
                "valid fenced code was rejected as nested blockquotes: {rendered}"
            );
        }

        let true_quote = format!(
            "{}deep\n",
            "> ".repeat(DEFAULT_RENDER_LIMITS.max_blockquote_depth + 1)
        );
        let rendered = render(&true_quote, None);
        assert!(
            rendered.contains("data-preview-limit=\"blockquote_depth\""),
            "a real over-budget blockquote must still be rejected: {rendered}"
        );
    }

    #[test]
    fn input_type_classification_uses_the_real_type_attribute() {
        let rejected = render("<input title='type=checkbox ' type=text>", None);
        assert!(
            !rejected.contains("<input"),
            "title text must not turn a text input into a checkbox: {rejected}"
        );

        let kept = render("<input title='type=text' type=checkbox>", None);
        assert!(
            kept.contains("<input title=\"type=text\" type=\"checkbox\">"),
            "the real type attribute must keep a checkbox: {kept}"
        );

        let newline_spoof = render("<input\n  title=\"type=checkbox\"\n  type=\"text\">", None);
        assert!(
            !newline_spoof.contains("<input"),
            "newline-separated attributes must be parsed structurally: {newline_spoof}"
        );
    }

    #[test]
    fn default_line_budget_reaches_the_diagnostic_render_path() {
        let source = "line\n".repeat(DEFAULT_RENDER_LIMITS.max_lines + 1);
        let original = source.clone();
        let rendered = render(&source, None);
        assert!(
            rendered.contains("data-preview-limit=\"lines\""),
            "the compatibility render API must surface the limit diagnostic: {rendered}"
        );
        assert_eq!(source, original, "the source must never be rewritten");
    }

    #[test]
    fn image_budgets_use_small_limits_and_count_every_occurrence() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(directory.path().join("pixel.png"), b"0123456789").unwrap();
        let source = "![a](pixel.png)\n\n![b](./pixel.png)";

        let occurrence_limits = RenderLimits {
            max_image_occurrences: 1,
            ..DEFAULT_RENDER_LIMITS
        };
        assert_eq!(
            render_with_blocks_checked(
                source,
                Some(directory.path()),
                false,
                &occurrence_limits,
                true
            )
            .unwrap_err()
            .kind,
            PreviewLimitKind::ImageOccurrences
        );

        // One encoded image fits, but the second reference (a canonical cache
        // hit) must still be charged.
        let single = render("![a](pixel.png)", Some(directory.path()));
        let url = single
            .split("src=\"")
            .nth(1)
            .unwrap()
            .split('"')
            .next()
            .unwrap()
            .to_owned();
        assert!(url.starts_with("data:image/png;base64,"));
        let repeat_limits = RenderLimits {
            max_encoded_image_bytes: url.len() + 16,
            ..DEFAULT_RENDER_LIMITS
        };
        assert_eq!(
            render_with_blocks_checked(source, Some(directory.path()), false, &repeat_limits, true)
                .unwrap_err()
                .kind,
            PreviewLimitKind::ImageBytes
        );
    }

    #[test]
    fn highlight_html_is_deterministic_and_oversized_fences_still_highlight() {
        let code = "fn main() {\n    println!(\"hi\");\n}\n";
        let first = highlight_html(Some("rust"), code);
        let second = highlight_html(Some("rust"), code);
        assert_eq!(first, second, "the highlight cache must be deterministic");
        assert!(first.contains("class=\"storage"), "{first}");

        // A single fence over the cache cap must still be highlighted; it is
        // simply not stored.
        let large = "let value = 1;\n".repeat(MAX_HIGHLIGHT_BYTES / 15 + 1);
        assert!(large.len() > MAX_HIGHLIGHT_BYTES);
        let html = highlight_html(Some("rust"), &large);
        assert!(
            html.contains("class=\"storage"),
            "an oversized fence must still be highlighted: {}",
            &html[..html.len().min(200)]
        );
    }

    #[test]
    fn highlight_code_strips_one_trailing_newline_and_keeps_markup() {
        // Classed output wraps the code in spans, so the raw HTML usually does
        // not end with the terminator; the helper must leave it unchanged then.
        let code = "fn main() {}\n";
        let raw = highlight_html(Some("rust"), code);
        let highlighted = highlight_code(code, Some("rust"));
        assert!(highlighted.contains("class=\"storage"), "{highlighted}");
        assert_eq!(highlighted, raw.strip_suffix('\n').unwrap_or(&raw));

        // The strip rule itself: exactly one newline, never more.
        let mut once = "value\n".to_owned();
        strip_trailing_newline(&mut once);
        assert_eq!(once, "value");
        let mut twice = "value\n\n".to_owned();
        strip_trailing_newline(&mut twice);
        assert_eq!(twice, "value\n");
        let mut none = "value".to_owned();
        strip_trailing_newline(&mut none);
        assert_eq!(none, "value");

        // Plain text is escaped, and the returned HTML never ends with a
        // dangling newline.
        let plain = highlight_code("<tag> & text\n", None);
        assert!(!plain.contains("<tag>"), "{plain}");
        assert!(plain.contains("&lt;tag&gt; &amp; text"), "{plain}");
        assert!(!plain.ends_with('\n'));

        // Code that does not end in a newline is returned unchanged.
        assert_eq!(
            highlight_code("plain text", None),
            highlight_html(None, "plain text")
        );
    }

    #[test]
    fn local_images_render_identically_through_the_process_wide_cache() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("pixel.png");
        fs::write(&path, b"0123456789").unwrap();
        let source = "![a](pixel.png)";

        let first = render(source, Some(directory.path()));
        let second = render(source, Some(directory.path()));
        assert_eq!(
            first, second,
            "the global image cache must return the same bytes"
        );
        assert!(
            first.contains("data:image/png;base64,MDEyMzQ1Njc4OQ=="),
            "{first}"
        );

        // A different file version (different length and mtime) invalidates
        // the cached encoding.
        fs::write(&path, b"changed-after-edit").unwrap();
        let changed = render(source, Some(directory.path()));
        assert_ne!(changed, first);
        assert!(!changed.contains("MDEyMzQ1Njc4OQ=="), "{changed}");
        assert!(changed.contains("data:image/png;base64,"), "{changed}");
    }

    #[test]
    fn render_still_sanitizes_raw_html_and_blocks_javascript_links() {
        let rendered = render(
            "# Title\n\n<script>alert(1)</script><img src=x onerror=alert(1)>\n\n[bad](javascript:alert(1))\n\n<a href=\"javascript:alert(1)\">raw bad</a>\n\n<iframe src=\"javascript:alert(1)\"></iframe>",
            None,
        );
        assert!(rendered.contains("id=\"doc-title\""), "{rendered}");
        assert!(!rendered.contains("<script"), "{rendered}");
        assert!(!rendered.contains("onerror"), "{rendered}");
        assert!(!rendered.contains("javascript:"), "{rendered}");
        assert!(!rendered.contains("<iframe"), "{rendered}");
    }

    #[test]
    fn image_paths_are_cached_by_canonical_path_and_reads_are_bounded() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(directory.path().join("pixel.png"), b"0123456789").unwrap();
        let rendered = render(
            "![a](pixel.png)\n\n![b](./pixel.png)",
            Some(directory.path()),
        );
        let sources: Vec<_> = rendered
            .split("src=\"")
            .skip(1)
            .map(|part| part.split('"').next().unwrap())
            .collect();
        assert_eq!(sources.len(), 2);
        assert_eq!(
            sources[0], sources[1],
            "canonical spellings share a cache entry"
        );
        assert_eq!(
            sources[0].matches("data:image/png;base64,").count(),
            1,
            "the cache must not concatenate encoded images"
        );

        let path = directory.path().join("pixel.png");
        assert!(
            images::read_bounded(&path, 4).is_none(),
            "the bounded read must enforce the budget even if metadata looked small"
        );
        assert!(images::read_bounded(&path, 10).is_some());

        let rendered = render("![a](pixel.png)", Some(directory.path()));
        assert!(rendered.contains("data:image/png;base64,"));
        let tiny_file_limit = RenderLimits {
            max_image_file_bytes: 4,
            ..DEFAULT_RENDER_LIMITS
        };
        let (html, _) = render_with_blocks_checked(
            "![a](pixel.png)",
            Some(directory.path()),
            false,
            &tiny_file_limit,
            true,
        )
        .unwrap();
        assert!(!html.contains("data:image/png;base64,"), "{html}");
        assert!(
            html.contains(LOCAL_IMAGE_PLACEHOLDER),
            "over-budget local files must use the safe placeholder: {html}"
        );
    }
}
