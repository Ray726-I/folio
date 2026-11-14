//! Self-contained offline HTML export.
//!
//! The trusted native renderer produces sanitized Markdown and leaves inert
//! substitution markers for math and Mermaid blocks. The UI renders those
//! sources with the same KaTeX build and isolated Mermaid bridge used by the
//! preview, then returns typed assets. This module validates every asset again
//! before filling a marker:
//!
//! - KaTeX HTML is rebuilt through a narrow MathML/SVG allow-list, with inline
//!   styles limited to the properties KaTeX needs and no URL-bearing values.
//! - Mermaid SVG goes through the renderer's existing trusted SVG sanitizer.
//! - Every failure becomes readable source text, never raw markup.
//!
//! The final document needs no scripts or network access. Local images were
//! already embedded as data URLs by the Markdown renderer; remote images stay
//! blocked, and only the selected theme's resolved colours and bundled fonts
//! are emitted.

use crate::{markdown, renderer};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use html5ever::{
    tendril::ByteTendril,
    tokenizer::{BufferQueue, Token, TokenSink, TokenSinkResult, Tokenizer},
};
use serde::Deserialize;
use std::{
    borrow::Cow,
    cell::RefCell,
    collections::{BTreeMap, HashMap, HashSet},
    path::Path,
    sync::LazyLock,
};

pub const MAX_EXPORT_ASSETS: usize = 512;
pub const MAX_ASSET_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_TOTAL_ASSET_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_EXPORT_BYTES: usize = 96 * 1024 * 1024;
const MAX_MATH_HTML_BYTES: usize = 4 * 1024 * 1024;
const MAX_THEME_VALUE_BYTES: usize = 32;

const EXPORT_CSP: &str = "default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; script-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'";

/// Resolved palette supplied by the UI. Values must be solid `#rrggbb` colours;
/// everything else is refused before it reaches a `<style>` block.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct ExportTheme {
    pub palette: BTreeMap<String, String>,
    pub font: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportAsset {
    pub id: String,
    pub kind: String,
    #[serde(default)]
    pub html: Option<String>,
    #[serde(default)]
    pub svg: Option<String>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedExport {
    pub jobs: Vec<markdown::ExportJob>,
    /// Upper bound for rendered assets. Any jobs beyond this fall back to
    /// readable source so a pathological document cannot force unbounded work.
    pub max_assets: usize,
}

pub fn prepare(
    source: &str,
    base: Option<&Path>,
    limits: &markdown::RenderLimits,
) -> Result<PreparedExport, String> {
    markdown::render_for_export(source, base, limits)
        .map(|(_, jobs)| PreparedExport {
            jobs,
            max_assets: MAX_EXPORT_ASSETS,
        })
        .map_err(|error| error.message)
}

pub fn export_document(
    source: &str,
    base: Option<&Path>,
    limits: &markdown::RenderLimits,
    assets: Vec<ExportAsset>,
    theme: ExportTheme,
) -> Result<String, String> {
    let (html, jobs) =
        markdown::render_for_export(source, base, limits).map_err(|error| error.message)?;
    let has_math = jobs.iter().any(|job| job.kind == "math");
    let body = substitute(html, &jobs, assets)?;
    let document = build_document(&body, has_math, &theme)?;
    if document.len() > MAX_EXPORT_BYTES {
        return Err(format!(
            "The exported HTML exceeds the {} MiB export limit.",
            MAX_EXPORT_BYTES / (1024 * 1024)
        ));
    }
    Ok(document)
}

const DIV_PREFIX: &str = "<div data-folio-export-job=\"";
const SPAN_PREFIX: &str = "<span data-folio-export-job=\"";

fn substitute(
    html: String,
    jobs: &[markdown::ExportJob],
    assets: Vec<ExportAsset>,
) -> Result<String, String> {
    assemble(html, jobs, assets).map(|(output, _)| output)
}

/// Fills every render slot. The markup is walked once: the search always
/// resumes at the last consumed marker, so a document that only contains one
/// marker kind (inline math is all spans) never rescans its remaining body
/// looking for the absent kind. The second return value is the number of bytes
/// the marker scan examined; tests use it to pin that linear bound.
fn assemble(
    html: String,
    jobs: &[markdown::ExportJob],
    assets: Vec<ExportAsset>,
) -> Result<(String, usize), String> {
    if assets.len() > MAX_EXPORT_ASSETS {
        return Err(format!(
            "The export contains more than the {MAX_EXPORT_ASSETS} rendered assets allowed."
        ));
    }
    let known: HashSet<&str> = jobs.iter().map(|job| job.id.as_str()).collect();
    let mut by_id = HashMap::with_capacity(assets.len());
    let mut asset_bytes = 0usize;
    for asset in assets {
        if !valid_id(&asset.id) || !known.contains(asset.id.as_str()) {
            return Err("The export received an unknown render slot.".into());
        }
        if !matches!(asset.kind.as_str(), "math" | "diagram") {
            return Err("The export received an unknown asset type.".into());
        }
        let expected = jobs
            .iter()
            .find(|job| job.id == asset.id)
            .map(|job| job.kind)
            .unwrap_or_default();
        if asset.kind != expected {
            return Err("The export received an asset for the wrong slot.".into());
        }
        asset_bytes = asset_bytes
            .saturating_add(asset.html.as_ref().map_or(0, String::len))
            .saturating_add(asset.svg.as_ref().map_or(0, String::len));
        if asset_bytes > MAX_TOTAL_ASSET_BYTES {
            return Err(format!(
                "The exported render assets exceed the {} MiB limit.",
                MAX_TOTAL_ASSET_BYTES / (1024 * 1024)
            ));
        }
        if by_id.insert(asset.id.clone(), asset).is_some() {
            return Err("The export received duplicate render slots.".into());
        }
    }

    let job_by_id: HashMap<&str, &markdown::ExportJob> =
        jobs.iter().map(|job| (job.id.as_str(), job)).collect();
    let mut used = HashSet::with_capacity(jobs.len());
    let mut output = String::with_capacity(html.len());
    let mut written = 0usize;
    let mut search = 0usize;
    let mut examined = 0usize;
    loop {
        let Some(offset) = html[search..].find('<') else {
            examined += html.len() - search;
            break;
        };
        examined += offset + 1;
        let start = search + offset;
        let candidate = &html[start..];
        let (tag, prefix) = if candidate.starts_with(DIV_PREFIX) {
            ("div", DIV_PREFIX)
        } else if candidate.starts_with(SPAN_PREFIX) {
            ("span", SPAN_PREFIX)
        } else {
            search = start + 1;
            continue;
        };
        let id_start = start + prefix.len();
        let Some(id_length) = html[id_start..].find('"') else {
            return Err("The export markup changed before it could be assembled.".into());
        };
        let id_end = id_start + id_length;
        let id = &html[id_start..id_end];
        let Some(job) = job_by_id.get(id).copied() else {
            return Err("The export markup changed before it could be assembled.".into());
        };
        if !used.insert(id) {
            return Err("The export markup changed before it could be assembled.".into());
        }
        let closing = format!(" data-folio-export-nonce=\"{}\"></{tag}>", job.nonce);
        let after = id_end + 1;
        if !html[after..].starts_with(&closing) {
            return Err("The export markup changed before it could be assembled.".into());
        }
        let replacement = match job.kind {
            "math" => render_math(job, by_id.get(id)),
            "diagram" => render_diagram(job, by_id.get(id)),
            _ => return Err("The export encountered an unknown render slot.".into()),
        };
        output.push_str(&html[written..start]);
        output.push_str(&replacement);
        written = after + closing.len();
        search = written;
    }
    output.push_str(&html[written..]);
    // Literal source text can mention the attribute name; only a real marker
    // element start is an unresolved slot.
    if used.len() != jobs.len() || output.contains(DIV_PREFIX) || output.contains(SPAN_PREFIX) {
        return Err("The export left an unresolved render slot.".into());
    }
    Ok((output, examined))
}

fn render_math(job: &markdown::ExportJob, asset: Option<&ExportAsset>) -> String {
    let rendered = asset
        .and_then(|asset| asset.html.as_deref())
        .filter(|html| !html.trim().is_empty())
        .and_then(|html| sanitize_math_html(html).ok());
    rendered.unwrap_or_else(|| math_fallback(job))
}

fn math_fallback(job: &markdown::ExportJob) -> String {
    let source = escape_html(&job.source);
    if job.block || job.display {
        format!("<pre class=\"math-source\"><code>{source}</code></pre>")
    } else {
        format!("<code class=\"math-source\">{source}</code>")
    }
}

fn render_diagram(job: &markdown::ExportJob, asset: Option<&ExportAsset>) -> String {
    let svg = asset
        .and_then(|asset| asset.svg.as_deref())
        .filter(|svg| !svg.trim().is_empty() && svg.len() <= MAX_ASSET_BYTES)
        .and_then(|svg| renderer::sanitize_svg_result(svg).ok())
        .filter(|svg| !svg.trim().is_empty() && svg.len() <= MAX_ASSET_BYTES);
    match svg {
        Some(svg) => format!("<div class=\"mermaid-host\">{svg}</div>"),
        None => format!(
            "<div class=\"mermaid-host\"><p class=\"mermaid-error\">Mermaid diagram could not be rendered.</p><pre class=\"mermaid-source\"><code>{}</code></pre></div>",
            escape_html(&job.source)
        ),
    }
}

fn valid_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn build_document(body: &str, has_math: bool, theme: &ExportTheme) -> Result<String, String> {
    let palette = resolve_palette(theme)?;
    let reading = match theme.font.as_deref() {
        None | Some("serif") => "var(--font-serif)",
        Some("sans") => "var(--font-ui)",
        Some("mono") => "var(--font-mono)",
        Some(_) => return Err("The export received an unknown reading font.".into()),
    };
    let mut css = String::with_capacity(1024 * 1024);
    css.push_str(":root{");
    for (key, variable) in PALETTE_VARIABLES {
        css.push_str(variable);
        css.push(':');
        css.push_str(palette.get(*key).map(String::as_str).unwrap_or("#000000"));
        css.push(';');
    }
    css.push_str("--font-reading:");
    css.push_str(reading);
    css.push(';');
    css.push('}');
    css.push_str(BASE_CSS);
    css.push_str(&FONT_CSS);
    if has_math {
        css.push_str(&KATEX_CSS);
    }
    let output = format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><meta http-equiv=\"Content-Security-Policy\" content=\"{EXPORT_CSP}\"><meta name=\"color-scheme\" content=\"dark light\"><title>Folio document</title><style>{css}</style></head><body><main class=\"markdown\">{ALERT_SPRITE}{body}</main></body></html>"
    );
    Ok(output)
}

const PALETTE_VARIABLES: &[(&str, &str)] = &[
    ("background", "--bg"),
    ("foreground", "--fg"),
    ("surface", "--surface"),
    ("panel", "--panel"),
    ("accent", "--accent"),
    ("selection", "--selection"),
    ("green", "--green"),
    ("red", "--red"),
    ("yellow", "--yellow"),
    ("blue", "--blue"),
    ("purple", "--purple"),
    ("muted", "--muted"),
    ("line", "--line"),
    ("hover", "--hover"),
];

const FALLBACK_PALETTE: &[(&str, &str)] = &[
    ("background", "#ffffff"),
    ("foreground", "#222222"),
    ("surface", "#f4f4f4"),
    ("panel", "#ffffff"),
    ("accent", "#2169bd"),
    ("selection", "#d9e8fa"),
    ("green", "#2e7d32"),
    ("red", "#c01c28"),
    ("yellow", "#805600"),
    ("blue", "#1968bf"),
    ("purple", "#813d9c"),
    ("muted", "#5c5c5c"),
    ("line", "#d8d8d8"),
    ("hover", "#eeeeec"),
];

fn resolve_palette(theme: &ExportTheme) -> Result<BTreeMap<String, String>, String> {
    let mut palette: BTreeMap<String, String> = FALLBACK_PALETTE
        .iter()
        .map(|(key, value)| (key.to_string(), value.to_string()))
        .collect();
    for (key, value) in &theme.palette {
        let Some(_) = PALETTE_VARIABLES
            .iter()
            .find(|(name, _)| *name == key.as_str())
        else {
            continue;
        };
        if value.len() > MAX_THEME_VALUE_BYTES || !valid_hex_color(value) {
            return Err(format!(
                "The export theme colour for {key} is not a solid hex colour."
            ));
        }
        palette.insert(key.clone(), value.to_ascii_lowercase());
    }
    Ok(palette)
}

fn valid_hex_color(value: &str) -> bool {
    value.len() == 7
        && value.starts_with('#')
        && value[1..].bytes().all(|byte| byte.is_ascii_hexdigit())
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

// --- KaTeX fragment validation -------------------------------------------

const KATEX_TAGS: &[&str] = &[
    "div",
    "span",
    "math",
    "semantics",
    "annotation",
    "mrow",
    "mi",
    "mo",
    "mn",
    "ms",
    "mtext",
    "mspace",
    "mfrac",
    "msqrt",
    "mroot",
    "mstyle",
    "mtable",
    "mtr",
    "mtd",
    "munder",
    "mover",
    "munderover",
    "msub",
    "msup",
    "msubsup",
    "mmultiscripts",
    "mprescripts",
    "none",
    "menclose",
    "mfenced",
    "mphantom",
    "mpadded",
    "maction",
    "svg",
    "g",
    "path",
    "line",
    "rect",
    "polyline",
    "polygon",
    "defs",
    "title",
    "desc",
];

const KATEX_ATTRIBUTES: &[&str] = &[
    "accent",
    "accentunder",
    "aria-hidden",
    "class",
    "columnalign",
    "columnlines",
    "columnspacing",
    "d",
    "display",
    "displaystyle",
    "encoding",
    "fence",
    "height",
    "bevelled",
    "columnwidth",
    "depth",
    "equalcolumns",
    "equalrows",
    "frame",
    "framespacing",
    "largeop",
    "linethickness",
    "lspace",
    "mathbackground",
    "mathcolor",
    "mathsize",
    "mathvariant",
    "maxsize",
    "minlabelspacing",
    "minsize",
    "movablelimits",
    "notation",
    "open",
    "close",
    "rowalign",
    "rspace",
    "separators",
    "preserveaspectratio",
    "preserveAspectRatio",
    "rowlines",
    "rowspacing",
    "scriptlevel",
    "side",
    "stretchy",
    "style",
    "symmetric",
    "viewbox",
    "viewBox",
    "voffset",
    "width",
    "x",
    "y",
    "x1",
    "x2",
    "y1",
    "y2",
    "cx",
    "cy",
    "r",
    "rx",
    "ry",
    "points",
    "fill",
    "stroke",
    "stroke-width",
    "stroke-linecap",
    "stroke-linejoin",
    "fill-rule",
    "clip-rule",
    "transform",
    "xmlns",
];

const INLINE_STYLE_PROPERTIES: &[&str] = &[
    "background",
    "background-color",
    "border",
    "bottom",
    "border-bottom",
    "border-bottom-color",
    "border-bottom-style",
    "border-bottom-width",
    "border-color",
    "border-left",
    "border-left-color",
    "border-left-style",
    "border-left-width",
    "border-radius",
    "border-right",
    "border-right-color",
    "border-right-style",
    "border-right-width",
    "border-style",
    "border-top",
    "border-top-color",
    "border-top-style",
    "border-top-width",
    "border-width",
    "clip",
    "color",
    "display",
    "fill",
    "fill-opacity",
    "font-family",
    "font-size",
    "font-style",
    "font-variant",
    "font-weight",
    "height",
    "left",
    "letter-spacing",
    "line-height",
    "margin",
    "margin-bottom",
    "margin-left",
    "margin-right",
    "margin-top",
    "max-width",
    "min-width",
    "opacity",
    "overflow",
    "padding",
    "padding-bottom",
    "padding-left",
    "padding-right",
    "padding-top",
    "position",
    "right",
    "stroke",
    "stroke-opacity",
    "stroke-width",
    "text-align",
    "text-decoration",
    "text-shadow",
    "text-transform",
    "top",
    "transform",
    "vertical-align",
    "white-space",
    "width",
    "word-spacing",
];

/// Inspect only tags and attributes, never text. KaTeX legitimately renders
/// literal prose such as `\text{a url(x) b}`; substring scanning the whole
/// fragment would mistake that for unsafe CSS and drop a valid formula.
/// Only genuinely executable or network-bearing constructs trigger fallback.
/// Harmless unknown tags/attributes are removed by the allow-list instead of
/// rejecting the whole formula, so a newer KaTeX presentation attribute cannot
/// silently disable math export.
fn dangerous_math_markup(input: &str) -> bool {
    let mut dangerous = false;
    tokenize_math_fragment(input, |token| {
        if dangerous {
            return;
        }
        let Token::TagToken(tag) = token else {
            return;
        };
        let tag_name: &str = tag.name.as_ref();
        if matches!(
            tag_name.to_ascii_lowercase().as_str(),
            "script"
                | "style"
                | "iframe"
                | "object"
                | "embed"
                | "image"
                | "img"
                | "foreignobject"
                | "a"
                | "use"
                | "meta"
                | "link"
                | "base"
                | "form"
        ) {
            dangerous = true;
            return;
        }
        for attribute in &tag.attrs {
            let attribute_name: &str = attribute.name.local.as_ref();
            let name = attribute_name.to_ascii_lowercase();
            if name.starts_with("on")
                || matches!(
                    name.as_str(),
                    "href"
                        | "src"
                        | "xlink:href"
                        | "srcset"
                        | "formaction"
                        | "action"
                        | "poster"
                        | "background"
                )
            {
                dangerous = true;
                return;
            }
        }
    });
    dangerous
}

fn sanitize_math_html(input: &str) -> Result<String, String> {
    if input.len() > MAX_MATH_HTML_BYTES {
        return Err("The rendered math exceeds the export limit.".into());
    }
    if dangerous_math_markup(input) {
        return Err("The rendered math contains unsupported markup.".into());
    }
    let tags: HashSet<&str> = KATEX_TAGS.iter().copied().collect();
    let attributes: HashSet<&str> = KATEX_ATTRIBUTES.iter().copied().collect();
    let mut builder = ammonia::Builder::default();
    builder
        .tags(tags)
        .generic_attributes(attributes)
        .url_schemes(HashSet::new())
        .attribute_filter(move |_element, attribute, value| -> Option<Cow<'_, str>> {
            let name = attribute.to_ascii_lowercase();
            match name.as_str() {
                "style" => sanitize_inline_style(value).map(Cow::Owned),
                "class" => valid_class(value).then_some(Cow::Borrowed(value)),
                "xmlns" => matches!(
                    value,
                    "http://www.w3.org/1998/Math/MathML" | "http://www.w3.org/2000/svg"
                )
                .then_some(Cow::Borrowed(value)),
                "encoding" => (value == "application/x-tex").then_some(Cow::Borrowed(value)),
                "aria-hidden" => matches!(value, "true" | "false").then_some(Cow::Borrowed(value)),
                "display" => matches!(value, "block" | "inline").then_some(Cow::Borrowed(value)),
                _ => safe_attribute_value(value).then_some(Cow::Borrowed(value)),
            }
        });
    let cleaned = builder.clean(input).to_string();
    let lower = cleaned.to_ascii_lowercase();
    // Check only genuine tag openings. Text is HTML-escaped, so prose such as
    // `url(x)` or `javascript:` inside a formula cannot match these.
    for forbidden in [
        "<script",
        "<style",
        "<iframe",
        "<object",
        "<embed",
        "<image",
        "<img",
        "<foreignobject",
    ] {
        if lower.contains(forbidden) {
            return Err("The rendered math contains unsupported markup.".into());
        }
    }
    if cleaned.trim().is_empty() {
        return Err("The rendered math was empty.".into());
    }
    Ok(cleaned)
}

fn valid_class(value: &str) -> bool {
    value.len() <= 512
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b' ' | b'-' | b'_'))
}

fn safe_attribute_value(value: &str) -> bool {
    value.len() <= 64 * 1024
        && !value
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
        && !value.contains('\\')
        && !contains_external_scheme(value)
        && !value.to_ascii_lowercase().contains("url(")
}

fn contains_external_scheme(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    [
        "http:",
        "https:",
        "data:",
        "javascript:",
        "blob:",
        "filesystem:",
        "file:",
    ]
    .iter()
    .any(|scheme| lower.contains(scheme))
        || lower.contains("://")
        || lower.starts_with("//")
}

fn sanitize_inline_style(value: &str) -> Option<String> {
    let cleaned = renderer::sanitize_css(value).ok()?;
    if cleaned.len() > 32 * 1024
        || cleaned.contains('@')
        || cleaned.contains('{')
        || cleaned.contains('}')
        || cleaned.contains('<')
        || cleaned.contains('>')
        || cleaned.contains("url(")
        || cleaned.contains('\\')
    {
        return None;
    }
    let mut safe = Vec::new();
    for declaration in cleaned.split(';') {
        let declaration = declaration.trim();
        if declaration.is_empty() {
            continue;
        }
        let Some((property, value)) = declaration.split_once(':') else {
            continue;
        };
        let property = property.trim().to_ascii_lowercase();
        if !INLINE_STYLE_PROPERTIES.contains(&property.as_str()) {
            continue;
        }
        let value = value.trim();
        if value.is_empty()
            || value.chars().any(char::is_control)
            || contains_external_scheme(value)
            || value.to_ascii_lowercase().contains("expression(")
        {
            continue;
        }
        if property == "position" && !matches!(value, "relative" | "absolute") {
            continue;
        }
        if property == "display"
            && !matches!(
                value,
                "inline" | "inline-block" | "block" | "table" | "none"
            )
        {
            continue;
        }
        safe.push(format!("{property}:{value}"));
    }
    (!safe.is_empty()).then(|| safe.join(";"))
}

// --- Bundled assets -------------------------------------------------------

const APP_FONTS: &[(&str, &str, &str, &[u8])] = &[
    (
        "Inter",
        "normal",
        "100 900",
        include_bytes!("../ui/fonts/inter-latin-wght-normal.woff2"),
    ),
    (
        "Source Serif 4",
        "normal",
        "200 900",
        include_bytes!("../ui/fonts/source-serif-4-latin-wght-normal.woff2"),
    ),
    (
        "Source Serif 4",
        "italic",
        "200 900",
        include_bytes!("../ui/fonts/source-serif-4-latin-wght-italic.woff2"),
    ),
    (
        "JetBrains Mono",
        "normal",
        "100 800",
        include_bytes!("../ui/fonts/jetbrains-mono-latin-wght-normal.woff2"),
    ),
    (
        "JetBrains Mono",
        "italic",
        "100 800",
        include_bytes!("../ui/fonts/jetbrains-mono-latin-wght-italic.woff2"),
    ),
];

static FONT_CSS: LazyLock<String> = LazyLock::new(|| {
    let mut css = String::new();
    for (family, style, weight, bytes) in APP_FONTS {
        css.push_str(&format!(
            "@font-face{{font-family:\"{family}\";src:url(data:font/woff2;base64,{}) format(\"woff2\");font-weight:{weight};font-style:{style};font-display:swap}}",
            STANDARD.encode(bytes)
        ));
    }
    css
});

const KATEX_FONTS: &[(&str, &[u8])] = &[
    (
        "KaTeX_AMS-Regular.woff2",
        include_bytes!("../ui/vendor/katex/fonts/KaTeX_AMS-Regular.woff2"),
    ),
    (
        "KaTeX_Caligraphic-Bold.woff2",
        include_bytes!("../ui/vendor/katex/fonts/KaTeX_Caligraphic-Bold.woff2"),
    ),
    (
        "KaTeX_Caligraphic-Regular.woff2",
        include_bytes!("../ui/vendor/katex/fonts/KaTeX_Caligraphic-Regular.woff2"),
    ),
    (
        "KaTeX_Fraktur-Bold.woff2",
        include_bytes!("../ui/vendor/katex/fonts/KaTeX_Fraktur-Bold.woff2"),
    ),
    (
        "KaTeX_Fraktur-Regular.woff2",
        include_bytes!("../ui/vendor/katex/fonts/KaTeX_Fraktur-Regular.woff2"),
    ),
    (
        "KaTeX_Main-Bold.woff2",
        include_bytes!("../ui/vendor/katex/fonts/KaTeX_Main-Bold.woff2"),
    ),
    (
        "KaTeX_Main-BoldItalic.woff2",
        include_bytes!("../ui/vendor/katex/fonts/KaTeX_Main-BoldItalic.woff2"),
    ),
    (
        "KaTeX_Main-Italic.woff2",
        include_bytes!("../ui/vendor/katex/fonts/KaTeX_Main-Italic.woff2"),
    ),
    (
        "KaTeX_Main-Regular.woff2",
        include_bytes!("../ui/vendor/katex/fonts/KaTeX_Main-Regular.woff2"),
    ),
    (
        "KaTeX_Math-BoldItalic.woff2",
        include_bytes!("../ui/vendor/katex/fonts/KaTeX_Math-BoldItalic.woff2"),
    ),
    (
        "KaTeX_Math-Italic.woff2",
        include_bytes!("../ui/vendor/katex/fonts/KaTeX_Math-Italic.woff2"),
    ),
    (
        "KaTeX_SansSerif-Bold.woff2",
        include_bytes!("../ui/vendor/katex/fonts/KaTeX_SansSerif-Bold.woff2"),
    ),
    (
        "KaTeX_SansSerif-Italic.woff2",
        include_bytes!("../ui/vendor/katex/fonts/KaTeX_SansSerif-Italic.woff2"),
    ),
    (
        "KaTeX_SansSerif-Regular.woff2",
        include_bytes!("../ui/vendor/katex/fonts/KaTeX_SansSerif-Regular.woff2"),
    ),
    (
        "KaTeX_Script-Regular.woff2",
        include_bytes!("../ui/vendor/katex/fonts/KaTeX_Script-Regular.woff2"),
    ),
    (
        "KaTeX_Size1-Regular.woff2",
        include_bytes!("../ui/vendor/katex/fonts/KaTeX_Size1-Regular.woff2"),
    ),
    (
        "KaTeX_Size2-Regular.woff2",
        include_bytes!("../ui/vendor/katex/fonts/KaTeX_Size2-Regular.woff2"),
    ),
    (
        "KaTeX_Size3-Regular.woff2",
        include_bytes!("../ui/vendor/katex/fonts/KaTeX_Size3-Regular.woff2"),
    ),
    (
        "KaTeX_Size4-Regular.woff2",
        include_bytes!("../ui/vendor/katex/fonts/KaTeX_Size4-Regular.woff2"),
    ),
    (
        "KaTeX_Typewriter-Regular.woff2",
        include_bytes!("../ui/vendor/katex/fonts/KaTeX_Typewriter-Regular.woff2"),
    ),
];

static KATEX_CSS: LazyLock<String> = LazyLock::new(|| {
    let mut css = include_str!("../ui/vendor/katex/katex.min.css").to_string();
    for (name, bytes) in KATEX_FONTS {
        let data = format!("url(data:font/woff2;base64,{})", STANDARD.encode(bytes));
        css = css.replace(&format!("url(fonts/{name})"), &data);
    }
    css
});

const ALERT_SPRITE: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" style="position:absolute;width:0;height:0;overflow:hidden" aria-hidden="true"><symbol id="i-alert-note" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 11v5"/><path d="M12 7.8h.01"/></symbol><symbol id="i-alert-tip" viewBox="0 0 24 24"><path d="M12 3.5a5.8 5.8 0 0 0-3.4 10.5c.8.6 1.4 1.3 1.4 2h4c0-.7.6-1.4 1.4-2A5.8 5.8 0 0 0 12 3.5Z"/><path d="M10 19.5h4"/><path d="M10.8 21.5h2.4"/></symbol><symbol id="i-alert-important" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 8v5"/><path d="M12 16.2h.01"/></symbol><symbol id="i-alert-warning" viewBox="0 0 24 24"><path d="M12 4.5 3.8 19.5h16.4L12 4.5Z"/><path d="M12 10v4"/><path d="M12 16.8h.01"/></symbol><symbol id="i-alert-caution" viewBox="0 0 24 24"><path d="M8.2 3.8h7.6l4.4 4.4v7.6l-4.4 4.4H8.2l-4.4-4.4V8.2l4.4-4.4Z"/><path d="M12 8.5v4.5"/><path d="M12 16.2h.01"/></symbol></svg>"##;

const BASE_CSS: &str = r#"
:root{--font-ui:"Inter",system-ui,"Segoe UI Variable Text","Adwaita Sans","Cantarell","Noto Sans",sans-serif;--font-serif:"Source Serif 4",Charter,"Iowan Old Style","Noto Serif","DejaVu Serif",Georgia,serif;--font-mono:"JetBrains Mono","Cascadia Code","SF Mono",Menlo,"DejaVu Sans Mono",monospace;--text-size:19px}
*,*::before,*::after{box-sizing:border-box}
html{background:var(--bg)}
body{margin:0;background:var(--bg);color:var(--fg);font:var(--text-size)/1.7 var(--font-reading);-webkit-text-size-adjust:100%}
.markdown{max-width:min(calc(720px + var(--text-size)*9),calc(68ch + 2*clamp(16px,4vw,56px)));margin:0 auto;padding:clamp(26px,5vh,54px) clamp(16px,4vw,56px) clamp(72px,14vh,150px);overflow-wrap:break-word}
.markdown>:first-child{margin-top:0}
.markdown h1,.markdown h2,.markdown h3,.markdown h4{line-height:1.3;font-weight:750;letter-spacing:-.025em}
.markdown h1{font-size:2em;margin:0 0 1em}
.markdown h2{font-size:1.5em;margin:1.8em 0 .75em}
.markdown h3{font-size:1.32em;margin:1.6em 0 .65em}
.markdown h4{font-size:1.12em;margin:1.45em 0 .55em}
.markdown p,.markdown ul,.markdown ol{margin:0 0 1.15em}
.markdown li{padding-left:.15em;margin:.3em 0}
.markdown li p{margin:.4em 0}
.markdown ul,.markdown ol{padding-left:1.5em}
.markdown li>input{accent-color:var(--accent);margin-right:.5em;width:14px;height:14px}
.markdown a{color:var(--accent);text-decoration:underline;text-underline-offset:3px}
.markdown code{font-family:var(--font-mono);font-size:.83em;color:inherit;background:var(--hover);border:0;border-radius:5px;padding:.12em .3em}
.markdown ul li::marker,.markdown ol li::marker{color:var(--accent)}
.markdown pre{overflow-x:auto;position:relative;border:1px solid var(--line);background:color-mix(in srgb,var(--surface) 60%,var(--bg));border-radius:10px;margin:1.5em 0;padding:24px 22px 19px;line-height:1.6;tab-size:4}
.markdown pre[data-language]:not([data-language=""])::before{content:attr(data-language);display:block;font-family:var(--font-ui);font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--accent);margin-bottom:10px}
.markdown pre code{font-size:.8em;background:none;border:none;border-radius:0;padding:0;white-space:pre}
.markdown .keyword,.markdown .storage{color:var(--purple)}
.markdown .string{color:var(--green)}
.markdown .comment{color:var(--muted);font-style:italic}
.markdown .constant,.markdown .support{color:var(--yellow)}
.markdown .entity.name{color:var(--blue)}
.markdown .source.json .dictionary.key .string{color:var(--blue)}
.markdown .source.diff .markup.deleted{color:var(--red)}
.markdown .source.diff .markup.inserted{color:var(--green)}
.markdown blockquote{margin:1.4em 0;border-left:3px solid var(--accent);padding:10px 18px;color:var(--muted);background:var(--hover);border-radius:10px}
.markdown blockquote>:last-child{margin-bottom:0}
.markdown .markdown-alert{padding:15px 18px;color:var(--fg);border-left:3px solid var(--accent);border-radius:10px;background:var(--hover)}
.markdown .markdown-alert-title{display:flex;align-items:center;gap:.45em;margin:0 0 .35em;color:var(--accent);font-weight:700}
.markdown .markdown-alert-icon{width:1.05em;height:1.05em;flex:none;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.markdown .markdown-alert-note{border-color:var(--blue)}
.markdown .markdown-alert-tip{border-color:var(--green)}
.markdown .markdown-alert-important{border-color:var(--purple)}
.markdown .markdown-alert-warning{border-color:var(--yellow)}
.markdown .markdown-alert-caution{border-color:var(--red)}
.markdown table{border-collapse:collapse;display:block;overflow-x:auto;width:fit-content;max-width:100%;margin:1.4em 0;font-size:.88em}
.markdown th,.markdown td{padding:10px 15px;border:1px solid var(--line);text-align:left}
.markdown th{background:var(--hover);font-weight:700}
.markdown thead th{border-bottom:2px solid color-mix(in srgb,var(--accent) 45%,var(--line))}
.markdown tr:nth-child(even){background:color-mix(in srgb,var(--fg) 3%,var(--bg))}
.markdown img{display:block;max-width:100%;height:auto;border-radius:8px;margin:1.2em 0}
.markdown hr{border:0;border-top:1px solid color-mix(in srgb,var(--accent) 28%,var(--line));margin:2em 0}
.markdown mark{color:var(--fg);background:var(--selection);border-radius:3px}
.markdown dl{margin:0 0 1.15em}
.markdown dt{font-weight:700;margin-top:.5em}
.markdown dd{margin:0 0 .4em 1.5em}
.markdown sub,.markdown sup{line-height:0}
.markdown .footnotes{font-size:.85em;color:var(--muted);margin-top:2.2em;border-top:1px solid color-mix(in srgb,var(--accent) 30%,var(--line));padding-top:1em}
.markdown .footnotes ol{margin:0;padding-left:1.4em}
.markdown .footnotes li{margin:.35em 0}
.markdown sup.footnote-ref a{color:var(--accent);text-decoration:none}
.markdown .footnote-backref{color:var(--muted);text-decoration:none}
.markdown .katex{font-size:1.02em}
.markdown .katex-display{max-width:100%;overflow-x:auto;overflow-y:hidden;padding:.15em 0}
.markdown .math-block{margin:1.3em 0;padding:10px 18px;border:1px solid var(--line);background:color-mix(in srgb,var(--surface) 55%,var(--bg));border-radius:10px;overflow-x:auto}
.markdown .math-block .katex-display{margin:0}
.markdown .math-source{font-family:var(--font-mono);font-size:.85em;color:var(--red)}
.markdown .mermaid-host{margin:1.4em 0;padding:10px 0 14px;border:0;background:transparent;overflow-x:auto}
.markdown .mermaid-host svg{display:block;margin:0 auto;max-width:100%;height:auto}
.markdown .mermaid-error{color:var(--red);font-size:13px;text-align:center;margin:0 0 10px}
.markdown pre.mermaid-source{margin:0;padding:12px 14px;font-size:12.5px;background:var(--bg)}
.markdown .preview-limit{border:1px solid var(--line);border-radius:10px;padding:16px 18px;background:var(--hover)}
@media (max-width:640px){.markdown{padding-left:18px;padding-right:18px}.markdown table{display:block}}
@media (forced-colors:active){.markdown .markdown-alert-icon{forced-color-adjust:auto}}
"#;

fn tokenize_math_fragment(html: &str, callback: impl FnMut(Token)) {
    struct CallbackSink<F>(RefCell<F>);
    impl<F: FnMut(Token)> TokenSink for CallbackSink<F> {
        type Handle = ();
        fn process_token(&self, token: Token, _line_number: u64) -> TokenSinkResult<()> {
            (self.0.borrow_mut())(token);
            TokenSinkResult::Continue
        }
    }

    let sink = CallbackSink(RefCell::new(callback));
    let mut chunk = ByteTendril::new();
    chunk.push_slice(html.as_bytes());
    let input = BufferQueue::default();
    input.push_back(chunk.try_reinterpret().unwrap());
    let tokenizer = Tokenizer::new(sink, Default::default());
    let _ = tokenizer.feed(&input);
    tokenizer.end();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn theme() -> ExportTheme {
        ExportTheme {
            palette: BTreeMap::from([
                ("background".into(), "#101010".into()),
                ("foreground".into(), "#f0f0f0".into()),
                ("accent".into(), "#7d82d9".into()),
            ]),
            font: Some("serif".into()),
        }
    }

    #[test]
    fn theme_values_are_strictly_validated() {
        let mut bad = theme();
        bad.palette
            .insert("accent".into(), "red;background:url(https://evil)".into());
        assert!(resolve_palette(&bad).is_err());
        let palette = resolve_palette(&theme()).unwrap();
        assert_eq!(palette["background"], "#101010");
        assert_eq!(palette["accent"], "#7d82d9");
    }

    #[test]
    fn katex_fragment_keeps_math_but_drops_scripts_urls_and_unknown_css() {
        let safe = sanitize_math_html(
            "<span class=\"katex\"><span class=\"katex-html\" aria-hidden=\"true\"><span class=\"mord\" style=\"height: 1.2em; vertical-align: -0.2em;\">x</span><svg width=\"400em\" height=\"1em\" viewBox=\"0 0 400000 1000\" preserveAspectRatio=\"xMinYMin slice\"><path d=\"M0 0\nL10 10\"/></svg></span><math xmlns=\"http://www.w3.org/1998/Math/MathML\"><mrow><mi>x</mi></mrow><annotation encoding=\"application/x-tex\">x</annotation></math></span>",
        )
        .unwrap();
        assert!(safe.contains("katex"));
        assert!(safe.contains("<math"));
        assert!(safe.contains("viewBox") || safe.contains("viewbox"));
        assert!(!safe.contains("script"));
        assert!(!safe.contains("http://evil"));
        assert!(sanitize_math_html(
            "<span class=\"katex\"><script>alert(1)</script><img src=\"https://evil/x.png\"></span>"
        )
        .is_err());
        let injected = sanitize_math_html(
            "<span class=\"katex\" style=\"position:fixed;inset:0;background:url(https://evil/x.png)\">x</span>",
        )
        .unwrap();
        assert!(!injected.contains("fixed"));
        assert!(!injected.contains("url("));
    }

    #[test]
    fn export_embeds_local_assets_and_falls_back_to_source() {
        let source =
            "# Title\n\nInline $x^2$ and display:\n\n```math\ny^2\n```\n\n```mermaid\ngraph TD;\nA-->B;\n```\n";
        let (prepared, jobs) =
            markdown::render_for_export(source, None, &markdown::DEFAULT_RENDER_LIMITS).unwrap();
        assert_eq!(jobs.len(), 3);
        assert!(prepared.contains("data-folio-export-job=\"math-0\""));
        assert!(prepared.contains("data-folio-export-job=\"diagram-0\""));
        let document = export_document(
            source,
            None,
            &markdown::DEFAULT_RENDER_LIMITS,
            vec![
                ExportAsset {
                    id: "math-0".into(),
                    kind: "math".into(),
                    html: Some("<span class=\"katex\"><math xmlns=\"http://www.w3.org/1998/Math/MathML\"><mi>x</mi></math></span>".into()),
                    svg: None,
                },
                ExportAsset {
                    id: "math-1".into(),
                    kind: "math".into(),
                    html: None,
                    svg: None,
                },
                ExportAsset {
                    id: "diagram-0".into(),
                    kind: "diagram".into(),
                    html: None,
                    svg: Some(
                        "<svg xmlns=\"http://www.w3.org/2000/svg\"><g><rect width=\"10\" height=\"10\"/></g></svg>"
                            .into(),
                    ),
                },
            ],
            theme(),
        )
        .unwrap();
        assert!(document.contains("#101010"));
        assert!(document.contains("data:font/woff2;base64,"));
        assert!(document.contains("<math"));
        assert!(document.contains("<svg"));
        assert!(document.contains("math-source"));
        assert!(!document.contains("<script"));
        assert!(!document.contains("https://"));
        assert!(!document.contains("data-folio-export-job"));
        assert!(!document.contains("<img src=\"https:"));
    }

    #[test]
    fn export_rejects_unknown_duplicate_or_mismatched_assets() {
        let source = "Inline $x$.\n";
        let jobs = markdown::render_for_export(source, None, &markdown::DEFAULT_RENDER_LIMITS)
            .unwrap()
            .1;
        let empty = || {
            markdown::render_for_export(source, None, &markdown::DEFAULT_RENDER_LIMITS)
                .unwrap()
                .0
        };
        let unknown = ExportAsset {
            id: "math-9".into(),
            kind: "math".into(),
            html: None,
            svg: None,
        };
        assert!(substitute(empty(), &jobs, vec![unknown]).is_err());
        let dup = ExportAsset {
            id: "math-0".into(),
            kind: "math".into(),
            html: None,
            svg: None,
        };
        assert!(substitute(empty(), &jobs, vec![dup.clone(), dup]).is_err());
        let wrong = ExportAsset {
            id: "math-0".into(),
            kind: "diagram".into(),
            html: None,
            svg: None,
        };
        assert!(substitute(empty(), &jobs, vec![wrong]).is_err());
    }

    #[test]
    fn author_html_cannot_forge_export_markers() {
        let (html, jobs) = markdown::render_for_export(
            "<span data-folio-export-job=\"math-0\" data-folio-export-nonce=\"forged\">forged</span>\n\nInline $x$.\n",
            None,
            &markdown::DEFAULT_RENDER_LIMITS,
        )
        .unwrap();
        assert_eq!(jobs.len(), 1);
        assert_eq!(html.matches("data-folio-export-job=").count(), 1);
        assert!(!html.contains("data-folio-export-nonce=\"forged\""));
        assert!(html.contains("forged"));
    }

    #[test]
    fn raw_html_contexts_drop_vanished_jobs_without_leaking_markers() {
        for source in [
            "Hello <script>$x$</script> end.",
            "<style>$x$</style>",
            "<textarea>$x$</textarea>",
            "<title>$x$</title>",
            "<iframe>$x$</iframe>",
            "<noscript>$x$</noscript>",
            "<template>$x$</template>",
        ] {
            let (html, jobs) =
                markdown::render_for_export(source, None, &markdown::DEFAULT_RENDER_LIMITS)
                    .unwrap();
            assert!(
                jobs.is_empty(),
                "{source:?} must drop vanished jobs: {html}"
            );
            assert!(
                !html.contains("data-folio-export-job"),
                "{source:?} leaked a marker: {html}"
            );
            // Export must succeed and fall back to nothing for vanished slots.
            assert!(export_document(
                source,
                None,
                &markdown::DEFAULT_RENDER_LIMITS,
                Vec::new(),
                theme(),
            )
            .is_ok());
        }
    }

    #[test]
    fn image_alt_math_stays_text_and_never_becomes_a_job() {
        for source in ["![alt $x$](x.png)", "![alt $$x$$](x.png)"] {
            let (html, jobs) =
                markdown::render_for_export(source, None, &markdown::DEFAULT_RENDER_LIMITS)
                    .unwrap();
            assert!(jobs.is_empty(), "{source:?} created a job: {html}");
            assert!(html.contains("alt=\"alt x\""), "{source:?}: {html}");
            assert!(export_document(
                source,
                None,
                &markdown::DEFAULT_RENDER_LIMITS,
                Vec::new(),
                theme(),
            )
            .is_ok());
        }
    }

    #[test]
    fn escaped_marker_recovery_keeps_math_source_between_author_text() {
        for source in [
            "Hello <textarea>abc $x$ xyz</textarea> end.",
            "<title>abc $x$ xyz</title>",
            "<noscript>abc $x$ xyz</noscript>",
            "<iframe>abc $x$ xyz</iframe>",
        ] {
            let (html, jobs) =
                markdown::render_for_export(source, None, &markdown::DEFAULT_RENDER_LIMITS)
                    .unwrap();
            assert!(jobs.is_empty(), "{source:?}: {html}");
            assert!(
                html.contains("abc x xyz") || html.contains("abc $x$ xyz"),
                "{source:?} lost source: {html}"
            );
            assert!(
                !html.contains("data-folio-export-nonce"),
                "{source:?}: {html}"
            );
        }
        for source in [
            "Hello <script>abc $x$ xyz</script> end.",
            "<style>abc $x$ xyz</style>",
            "<template>abc $x$ xyz</template>",
        ] {
            let (html, jobs) =
                markdown::render_for_export(source, None, &markdown::DEFAULT_RENDER_LIMITS)
                    .unwrap();
            assert!(jobs.is_empty(), "{source:?}: {html}");
            assert!(!html.contains("abc x xyz"), "{source:?}: {html}");
            assert!(
                !html.contains("data-folio-export-nonce"),
                "{source:?}: {html}"
            );
        }
    }

    #[test]
    fn vanished_marker_scrub_preserves_author_literal_marker_text() {
        let source = "Hello <textarea>$x$</textarea> end.\n\n`<span data-folio-export-job=\"math-0\"></span>`\n\nEscaped &lt;span data-folio-export-job=\"math-0\"&gt;&lt;/span&gt;.";
        let (html, jobs) =
            markdown::render_for_export(source, None, &markdown::DEFAULT_RENDER_LIMITS).unwrap();
        assert!(jobs.is_empty(), "the textarea math must vanish: {html}");
        assert!(
            html.contains("&lt;span data-folio-export-job=\"math-0\"&gt;&lt;/span&gt;"),
            "author code-span marker text was deleted: {html}"
        );
        assert!(
            html.contains("data-folio-export-job=\"math-0\""),
            "author escaped text was deleted: {html}"
        );
        assert!(!html.contains("data-folio-export-nonce"), "{html}");
        let document = export_document(
            source,
            None,
            &markdown::DEFAULT_RENDER_LIMITS,
            Vec::new(),
            theme(),
        )
        .unwrap();
        assert!(document.contains("data-folio-export-job=\"math-0\""));
    }

    #[test]
    fn literal_marker_text_is_not_an_unresolved_slot() {
        let source = "Literal data-folio-export-job= value.\n\nInline $x$.";
        let document = export_document(
            source,
            None,
            &markdown::DEFAULT_RENDER_LIMITS,
            Vec::new(),
            theme(),
        )
        .unwrap();
        assert!(document.contains("data-folio-export-job= value"));
        assert!(!document.contains("<div data-folio-export-job="));
        assert!(!document.contains("<span data-folio-export-job="));
        assert!(document.contains("math-source"));
    }

    #[test]
    fn raw_html_images_are_embedded_and_remote_sources_stay_blocked() {
        let directory = tempfile::tempdir().unwrap();
        let png = STANDARD.decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lYQ5WQAAAABJRU5ErkJggg==",
        )
        .unwrap();
        std::fs::write(directory.path().join("pixel.png"), png).unwrap();
        let source = "<img src=\"pixel.png\" srcset=\"https://example.com/x.png 2x\" alt=\"raw\">\n\n<img src=\"https://example.com/remote.png\" alt=\"remote\">\n\n<img src=\"data:image/png;base64,iVBORw0KGgo=\" alt=\"embedded\">";
        let (html, jobs) = markdown::render_for_export(
            source,
            Some(directory.path()),
            &markdown::DEFAULT_RENDER_LIMITS,
        )
        .unwrap();
        assert!(jobs.is_empty());
        assert!(html.contains("alt=\"raw\""));
        assert!(html.contains("data:image/png;base64,"), "{html}");
        assert!(!html.contains("srcset"), "{html}");
        assert!(!html.contains("https://example.com/remote.png"), "{html}");
        assert!(html.contains("alt=\"remote\""));
        assert!(!html.contains("https://example.com/x.png"), "{html}");
        assert!(export_document(
            source,
            Some(directory.path()),
            &markdown::DEFAULT_RENDER_LIMITS,
            Vec::new(),
            theme(),
        )
        .is_ok());
    }

    #[test]
    fn katex_presentation_attributes_styles_and_unknown_harmless_attrs_roundtrip() {
        let fragment = "<span class=\"katex\"><span class=\"katex-mathml\"><math xmlns=\"http://www.w3.org/1998/Math/MathML\"><mstyle mathsize=\"2.44em\" voffset=\"2pt\" lspace=\"-0.1em\"><mphantom depth=\"0em\"><mtext>x</mtext></mphantom></mstyle></math></span><span class=\"katex-html\"><span class=\"mord\" data-future=\"harmless\" style=\"text-shadow: 0.1em 0.1em 0 #ccc; right: -0.1em; stroke: #333;\">x</span></span></span>";
        let safe = sanitize_math_html(fragment).unwrap();
        for expected in [
            "mathsize=\"2.44em\"",
            "voffset=\"2pt\"",
            "lspace=\"-0.1em\"",
            "depth=\"0em\"",
            "text-shadow:0.1em 0.1em 0 #ccc",
            "right:-0.1em",
            "stroke:#333",
        ] {
            assert!(safe.contains(expected), "missing {expected}: {safe}");
        }
        assert!(!safe.contains("data-future"), "{safe}");
        assert!(dangerous_math_markup(
            "<span style=\"color: red\" onclick=\"alert(1)\">x</span>"
        ));
        assert!(dangerous_math_markup(
            "<a href=\"https://example.com\">x</a>"
        ));
    }

    #[test]
    fn harmless_math_text_does_not_look_like_unsafe_markup() {
        let text = "a url(x) b javascript: href= data:";
        let fragment = format!(
            "<span class=\"katex\"><span class=\"katex-mathml\"><math xmlns=\"http://www.w3.org/1998/Math/MathML\"><mtext>{text}</mtext><annotation encoding=\"application/x-tex\">{text}</annotation></math></span><span class=\"katex-html\" aria-hidden=\"true\"><span class=\"mord text\"><span class=\"mord\">{text}</span></span></span></span>"
        );
        let safe = sanitize_math_html(&fragment).unwrap();
        assert!(safe.contains("url(x)"));
        assert!(safe.contains("javascript:"));
        assert!(safe.contains("href="));
        assert!(
            sanitize_math_html("<span class=\"katex\"><script>alert(1)</script></span>").is_err()
        );
    }

    #[test]
    fn prepare_exposes_a_bounded_asset_cap() {
        let prepared = prepare("Inline $x$.", None, &markdown::DEFAULT_RENDER_LIMITS).unwrap();
        assert_eq!(prepared.max_assets, MAX_EXPORT_ASSETS);
        assert_eq!(prepared.jobs.len(), 1);
        assert_eq!(prepared.jobs[0].id, "math-0");
        assert_eq!(prepared.jobs[0].kind, "math");
        let value = serde_json::to_value(&prepared).unwrap();
        assert_eq!(value["maxAssets"], MAX_EXPORT_ASSETS);
        assert_eq!(value["jobs"][0]["kind"], "math");
        assert_eq!(value["jobs"][0]["block"], false);
    }

    #[test]
    fn excessive_asset_lists_are_refused_before_rendering() {
        let assets = (0..=MAX_EXPORT_ASSETS)
            .map(|index| ExportAsset {
                id: format!("math-{index}"),
                kind: "math".into(),
                html: None,
                svg: None,
            })
            .collect();
        assert!(substitute(String::new(), &[], assets).is_err());
    }

    #[test]
    fn bundled_assets_have_no_network_urls() {
        assert!(!FONT_CSS.contains("url(\"") && FONT_CSS.contains("data:font/woff2"));
        assert!(KATEX_CSS.contains("data:font/woff2;base64,"));
        assert!(!KATEX_CSS.contains("url(fonts/"));
        assert!(!KATEX_CSS.contains("http://") && !KATEX_CSS.contains("https://"));
    }

    fn inline_math_document(count: usize) -> (String, Vec<markdown::ExportJob>) {
        let mut html = String::from("<article><p>");
        let mut jobs = Vec::with_capacity(count);
        for index in 0..count {
            let id = format!("math-{index}");
            let nonce = format!("n{index}");
            html.push_str(&format!(
                "<span data-folio-export-job=\"{id}\" data-folio-export-nonce=\"{nonce}\"></span>"
            ));
            html.push_str("inline text ");
            jobs.push(markdown::ExportJob {
                id,
                kind: "math",
                source: "x".into(),
                display: false,
                block: false,
                nonce,
            });
        }
        html.push_str("</p></article>");
        (html, jobs)
    }

    fn mixed_marker_document(count: usize) -> (String, Vec<markdown::ExportJob>) {
        let mut html = String::from("<article><p>intro</p>");
        let mut jobs = Vec::with_capacity(count);
        for index in 0..count {
            let nonce = format!("nonce-{index}");
            let (tag, id, kind) = if index % 2 == 0 {
                ("span", format!("math-{index}"), "math")
            } else {
                ("div", format!("diagram-{index}"), "diagram")
            };
            html.push_str(&format!("<section><em>step {index}</em>"));
            html.push_str(&format!(
                "<{tag} data-folio-export-job=\"{id}\" data-folio-export-nonce=\"{nonce}\"></{tag}>"
            ));
            html.push_str(" after</section>");
            jobs.push(markdown::ExportJob {
                id,
                kind,
                source: "x".into(),
                display: false,
                block: false,
                nonce,
            });
        }
        (html, jobs)
    }

    #[test]
    fn inline_math_only_markup_is_scanned_once() {
        // Inline math uses span markers only. Looking for the absent div prefix
        // across the remaining document for every slot used to make assembly
        // quadratic in the number of slots.
        let (html, jobs) = inline_math_document(4096);
        let (output, examined) = assemble(html.clone(), &jobs, Vec::new()).unwrap();
        assert!(!output.contains("data-folio-export-job"));
        assert_eq!(output.matches("math-source").count(), jobs.len());
        assert!(
            examined <= html.len(),
            "assembly examined {examined} bytes of {}; the scan must not restart",
            html.len()
        );
    }

    #[test]
    fn mixed_markers_keep_order_and_scan_each_byte_once() {
        for count in [1, 3, 64, 1024, 4096] {
            let (html, jobs) = mixed_marker_document(count);
            let (output, examined) = assemble(html.clone(), &jobs, Vec::new()).unwrap();
            assert!(!output.contains("data-folio-export-job"), "{count} slots");
            assert_eq!(
                output.matches("math-source").count(),
                count.div_ceil(2),
                "{count} slots"
            );
            assert_eq!(
                output.matches("mermaid-source").count(),
                count / 2,
                "{count} slots"
            );
            assert!(
                examined <= html.len(),
                "{count} slots examined {examined} bytes of {}",
                html.len()
            );
            let math = output.find("math-source");
            let diagram = output.find("mermaid-source");
            if count >= 2 {
                assert!(math < diagram, "{count} slots lost document order");
            }
        }
    }

    #[test]
    fn assembly_rejects_malformed_or_unresolved_markers() {
        let jobs = [markdown::ExportJob {
            id: "math-0".into(),
            kind: "math",
            source: "x".into(),
            display: false,
            block: false,
            nonce: "n0".into(),
        }];
        for markup in [
            // Unknown slot.
            "<span data-folio-export-job=\"math-9\" data-folio-export-nonce=\"n0\"></span>",
            // Id is never terminated.
            "<span data-folio-export-job=\"math-0",
            // Nonce attribute missing.
            "<span data-folio-export-job=\"math-0\"></span>",
            // Nonce does not match the job.
            "<span data-folio-export-job=\"math-0\" data-folio-export-nonce=\"other\"></span>",
            // Marker closed with the wrong element.
            "<span data-folio-export-job=\"math-0\" data-folio-export-nonce=\"n0\"></div>",
            // One slot cannot be filled twice.
            "<span data-folio-export-job=\"math-0\" data-folio-export-nonce=\"n0\"></span><span data-folio-export-job=\"math-0\" data-folio-export-nonce=\"n0\"></span>",
            // A job whose marker never arrives.
            "<p>plain</p>",
        ] {
            assert!(assemble(markup.into(), &jobs, Vec::new()).is_err(), "{markup:?}");
        }

        let (output, examined) = assemble(
            "<p><span data-folio-export-job=\"math-0\" data-folio-export-nonce=\"n0\"></span></p>"
                .into(),
            &jobs,
            Vec::new(),
        )
        .unwrap();
        assert!(output.contains("<code class=\"math-source\">x</code>"));
        assert!(examined > 0);
    }

    /// Manual profile hook for the slot-assembly scan:
    /// `cargo test --release --locked bench_inline_math_assembly -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn bench_inline_math_assembly() {
        for count in [1000, 2000, 4000] {
            let (html, jobs) = inline_math_document(count);
            let started = std::time::Instant::now();
            let output = substitute(html.clone(), &jobs, Vec::new()).unwrap();
            println!(
                "count={count} bytes={} out={} elapsed={:?}",
                html.len(),
                output.len(),
                started.elapsed()
            );
        }
    }
}
