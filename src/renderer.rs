//! Offline Mermaid renderer boundary.
//!
//! Transport contract (also consumed by `ui/preview.js` and
//! `ui/mermaid-renderer.js`):
//!
//! Main webview (`main`) may call:
//! - `mermaid_render_request({ request: { id, source, theme: { variables } } })`
//! - `mermaid_render_cancel({ id })`
//!
//! Renderer webview (`mermaid-renderer`) may call:
//! - `mermaid_renderer_ready()`
//! - `mermaid_render_result({ id, result: { svg } | { error: { code, message } } })`
//!
//! Rust emits these events:
//! - to `mermaid-renderer`: `mermaid-render-request` with the request object.
//! - to `mermaid-renderer`: `mermaid-render-cancel` with `{ id }`.
//! - to `main`: `mermaid-render-result` with
//!   `{ id, ok: true, svg, sanitized: true }` or
//!   `{ id, ok: false, sanitized: false, error: { code, message } }`.
//!
//! `theme.variables` is a bounded map of Mermaid theme variables. Values are
//! booleans or short strings; CSS URL functions are refused. The renderer
//! combines them with a fixed `theme: "base"` / `securityLevel: "strict"` /
//! `htmlLabels: false` configuration.
//!
//! The renderer sanitizes before returning, and the trusted Rust side parses
//! and sanitizes the SVG/CSS again before forwarding any result to the parent.
//! The renderer's sanitizer is an early filter, not the trust boundary.
//!
//! Only the main webview may submit/cancel. Only the renderer webview may
//! report readiness/results, and only for an outstanding request it owns. The
//! renderer has no file/document/dialog/opener commands.

use cssparser::{BasicParseErrorKind, ParseError, Parser, Token};
use roxmltree::Node;
use serde::{Deserialize, Serialize};
use std::{
    borrow::Cow,
    collections::BTreeMap,
    fmt,
    time::{Duration, Instant},
};
#[cfg(debug_assertions)]
use tauri::Manager;
use tauri::{
    http::{
        header::{HeaderValue, CONTENT_SECURITY_POLICY},
        Request, Response,
    },
    WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

pub const MAIN_LABEL: &str = "main";
pub const RENDERER_LABEL: &str = "mermaid-renderer";

/// The renderer document gets its own CSP, independent of the main document
/// (which still permits remote Markdown images according to the user's
/// preference). `default-src 'none'` plus the narrow allow-list below means
/// that even a request made in the middle of `mermaid.render` cannot reach the
/// network. `connect-src` is limited to Tauri IPC; external scripts, styles,
/// fonts, frames, workers, media, and images are all denied.
pub const RENDERER_CSP: &str = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'none'; font-src 'none'; connect-src ipc: http://ipc.localhost; media-src 'none'; object-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; manifest-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

pub const MAX_SOURCE_BYTES: usize = 256 * 1024;
pub const MAX_SVG_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_ERROR_MESSAGE_BYTES: usize = 2 * 1024;
pub const MAX_OUTSTANDING_REQUESTS: usize = 32;
pub const MAX_THEME_VARIABLES: usize = 256;
pub const MAX_THEME_KEY_BYTES: usize = 64;
pub const MAX_THEME_VALUE_BYTES: usize = 128;
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

const ALLOWED_ERROR_CODES: &[&str] = &[
    "render_failed",
    "invalid_source",
    "unsupported_external_images",
    "cancelled",
    "internal_error",
];

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PickerKind {
    File,
    Folder,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenderRequest {
    pub id: String,
    pub source: String,
    #[serde(default)]
    pub theme: RendererTheme,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RendererTheme {
    #[serde(default)]
    pub variables: BTreeMap<String, ThemeValue>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum ThemeValue {
    Bool(bool),
    Text(String),
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenderFailure {
    pub code: String,
    pub message: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenderResult {
    #[serde(default)]
    pub svg: Option<String>,
    #[serde(default)]
    pub error: Option<RenderFailure>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RenderResultEvent {
    pub id: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub svg: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<RenderFailure>,
    pub sanitized: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelRequest {
    pub id: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TransportError {
    InvalidId,
    SourceTooLarge,
    InvalidTheme,
    DuplicateId,
    TooManyRequests,
    UnknownRequest,
    NotDispatched,
}

impl fmt::Display for TransportError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            TransportError::InvalidId => "Diagram render request IDs must be short ASCII tokens.",
            TransportError::SourceTooLarge => "The Mermaid source exceeds the renderer limit.",
            TransportError::InvalidTheme => "The Mermaid theme payload is invalid.",
            TransportError::DuplicateId => "That diagram render request is already outstanding.",
            TransportError::TooManyRequests => "Too many diagram renders are outstanding.",
            TransportError::UnknownRequest => "That diagram render request is not outstanding.",
            TransportError::NotDispatched => "That diagram render request has not been dispatched.",
        };
        formatter.write_str(message)
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum AcceptOutcome {
    Accepted(RenderResultEvent),
    Rejected { id: String, failure: RenderFailure },
}

struct Outstanding {
    request: RenderRequest,
    dispatched: bool,
    submitted: Instant,
}

/// Native-side ownership and validation for the renderer transport. This is
/// intentionally independent of Tauri so the security rules can be unit
/// tested without a display server.
#[derive(Default)]
pub struct Transport {
    ready: bool,
    requests: BTreeMap<String, Outstanding>,
}

impl Transport {
    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.requests.len()
    }

    pub fn is_empty(&self) -> bool {
        self.requests.is_empty()
    }

    pub fn mark_ready(&mut self) -> Vec<RenderRequest> {
        self.ready = true;
        self.requests
            .values_mut()
            .map(|outstanding| {
                outstanding.dispatched = true;
                outstanding.request.clone()
            })
            .collect()
    }

    /// Called when the renderer webview is recreated. Pending requests are
    /// re-dispatched only after the new document registers its listener.
    pub fn reset_ready(&mut self) {
        self.ready = false;
        for outstanding in self.requests.values_mut() {
            outstanding.dispatched = false;
        }
    }

    /// Validates and records a request. Returns `true` when the renderer is
    /// already ready and the caller should dispatch it immediately.
    pub fn submit(&mut self, request: RenderRequest) -> Result<bool, TransportError> {
        validate_request(&request)?;
        if self.requests.contains_key(&request.id) {
            return Err(TransportError::DuplicateId);
        }
        if self.requests.len() >= MAX_OUTSTANDING_REQUESTS {
            return Err(TransportError::TooManyRequests);
        }
        let dispatched = self.ready;
        self.requests.insert(
            request.id.clone(),
            Outstanding {
                request,
                dispatched,
                submitted: Instant::now(),
            },
        );
        Ok(dispatched)
    }

    /// Returns `None` when the ID was not outstanding, `Some(false)` for a
    /// queued request, and `Some(true)` when the request had been dispatched
    /// to the renderer and any active work must be recycled.
    pub fn cancel(&mut self, id: &str) -> Result<Option<bool>, TransportError> {
        if !valid_id(id) {
            return Err(TransportError::InvalidId);
        }
        Ok(self
            .requests
            .remove(id)
            .map(|outstanding| outstanding.dispatched))
    }

    pub fn take_all_pending(&mut self) -> Vec<String> {
        let ids = self.requests.keys().cloned().collect();
        self.requests.clear();
        self.ready = false;
        ids
    }

    pub fn prune(&mut self, now: Instant) -> Vec<String> {
        let stale = self
            .requests
            .iter()
            .filter(|(_, outstanding)| {
                now.saturating_duration_since(outstanding.submitted) >= REQUEST_TIMEOUT
            })
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for id in &stale {
            self.requests.remove(id);
        }
        stale
    }

    /// Accepts only a result for an outstanding, dispatched request. The entry
    /// is removed whether the result is accepted or rejected so a malformed
    /// result cannot pin an ID forever. Unknown and duplicate results are
    /// rejected without producing an event.
    pub fn accept(
        &mut self,
        id: &str,
        result: RenderResult,
    ) -> Result<AcceptOutcome, TransportError> {
        if !valid_id(id) {
            return Err(TransportError::InvalidId);
        }
        let Some(outstanding) = self.requests.get(id) else {
            return Err(TransportError::UnknownRequest);
        };
        if !outstanding.dispatched {
            return Err(TransportError::NotDispatched);
        }
        self.requests.remove(id);
        match validate_result(id, result) {
            Ok(event) => Ok(AcceptOutcome::Accepted(event)),
            Err(message) => Ok(AcceptOutcome::Rejected {
                id: id.to_string(),
                failure: RenderFailure {
                    code: "invalid_result".into(),
                    message,
                },
            }),
        }
    }

    #[cfg(test)]
    fn backdate(&mut self, id: &str, age: Duration) {
        if let Some(outstanding) = self.requests.get_mut(id) {
            outstanding.submitted = Instant::now() - age;
        }
    }
}

fn validate_request(request: &RenderRequest) -> Result<(), TransportError> {
    if !valid_id(&request.id) {
        return Err(TransportError::InvalidId);
    }
    if request.source.len() > MAX_SOURCE_BYTES {
        return Err(TransportError::SourceTooLarge);
    }
    if request.theme.variables.len() > MAX_THEME_VARIABLES {
        return Err(TransportError::InvalidTheme);
    }
    for (key, value) in &request.theme.variables {
        if key.is_empty()
            || key.len() > MAX_THEME_KEY_BYTES
            || !key.bytes().enumerate().all(|(index, byte)| {
                byte.is_ascii_alphabetic()
                    || (index > 0 && byte.is_ascii_digit())
                    || (index > 0 && byte == b'_')
            })
        {
            return Err(TransportError::InvalidTheme);
        }
        if let ThemeValue::Text(value) = value {
            if value.len() > MAX_THEME_VALUE_BYTES || !safe_theme_value(value) {
                return Err(TransportError::InvalidTheme);
            }
        }
    }
    Ok(())
}

fn validate_result(id: &str, result: RenderResult) -> Result<RenderResultEvent, String> {
    match (result.svg, result.error) {
        (Some(svg), None) => {
            if svg.len() > MAX_SVG_BYTES {
                return Err("The renderer result exceeds the SVG size limit.".into());
            }
            let sanitized = sanitize_svg_result(&svg)?;
            if sanitized.len() > MAX_SVG_BYTES {
                return Err("The sanitized renderer result exceeds the SVG size limit.".into());
            }
            Ok(RenderResultEvent {
                id: id.into(),
                ok: true,
                svg: Some(sanitized),
                error: None,
                sanitized: true,
            })
        }
        (None, Some(failure)) => {
            if !ALLOWED_ERROR_CODES.contains(&failure.code.as_str()) {
                return Err("The renderer returned an unknown failure code.".into());
            }
            if failure.message.len() > MAX_ERROR_MESSAGE_BYTES {
                return Err("The renderer failure message is too long.".into());
            }
            Ok(RenderResultEvent {
                id: id.into(),
                ok: false,
                svg: None,
                error: Some(failure),
                sanitized: false,
            })
        }
        _ => Err("The renderer must return exactly one of SVG or a failure.".into()),
    }
}

fn valid_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn safe_theme_value(value: &str) -> bool {
    if value.chars().any(char::is_control) {
        return false;
    }
    let lower = value.to_ascii_lowercase();
    !lower.contains(';')
        && !lower.contains('{')
        && !lower.contains('}')
        && !lower.contains('@')
        && !lower.contains('\\')
        && !lower.contains("url(")
        && !lower.contains("http:")
        && !lower.contains("https:")
        && !lower.contains("javascript:")
        && !lower.contains("expression(")
        && !lower.contains("/*")
        && !lower.contains("*/")
}

const SVG_NS: &str = "http://www.w3.org/2000/svg";
const XLINK_NS: &str = "http://www.w3.org/1999/xlink";
const XML_NS: &str = "http://www.w3.org/XML/1998/namespace";
const MAX_SVG_DEPTH: usize = 256;
const MAX_CSS_NESTING: usize = 128;

const SAFE_SVG_TAGS: &[&str] = &[
    "svg",
    "g",
    "defs",
    "symbol",
    "use",
    "marker",
    "pattern",
    "clippath",
    "lineargradient",
    "radialgradient",
    "stop",
    "filter",
    "feblend",
    "fecolormatrix",
    "fecomponenttransfer",
    "fecomposite",
    "feconvolvematrix",
    "fediffuselighting",
    "fedisplacementmap",
    "fedistantlight",
    "fedropshadow",
    "feflood",
    "fefunca",
    "fefuncb",
    "fefuncg",
    "fefuncr",
    "fegaussianblur",
    "femerge",
    "femergenode",
    "femorphology",
    "feoffset",
    "fepointlight",
    "fespecularlighting",
    "fespotlight",
    "fetile",
    "feturbulence",
    "path",
    "rect",
    "circle",
    "ellipse",
    "line",
    "polyline",
    "polygon",
    "text",
    "tspan",
    "textpath",
    "title",
    "desc",
    "style",
    "switch",
    "view",
];

const DANGEROUS_SVG_TAGS: &[&str] = &[
    "script",
    "foreignobject",
    "iframe",
    "object",
    "embed",
    "image",
    "feimage",
    "a",
    "animate",
    "animatecolor",
    "animatemotion",
    "animatetransform",
    "set",
    "discard",
    "audio",
    "video",
    "canvas",
    "handler",
    "listener",
    "cursor",
    "font-face",
    "font-face-src",
    "font-face-uri",
];

const URL_ATTRIBUTES: &[&str] = &[
    "fill",
    "stroke",
    "filter",
    "clip-path",
    "mask",
    "marker-start",
    "marker-mid",
    "marker-end",
    "cursor",
    "color-profile",
    "shape-inside",
];

const SAFE_SVG_ATTRIBUTES: &[&str] = &[
    "accent-height",
    "accumulate",
    "additive",
    "alignment-baseline",
    "allowreorder",
    "alphabetic",
    "amplitude",
    "arabic-form",
    "ascent",
    "attributename",
    "attributetype",
    "autoreverse",
    "azimuth",
    "basefrequency",
    "baselineshift",
    "baseprofile",
    "bbox",
    "begin",
    "bias",
    "by",
    "calcmode",
    "cap-height",
    "class",
    "clip",
    "clip-path",
    "clip-rule",
    "clippathunits",
    "color",
    "color-interpolation",
    "color-interpolation-filters",
    "color-profile",
    "color-rendering",
    "cursor",
    "cx",
    "cy",
    "d",
    "decelerate",
    "descent",
    "diffuseconstant",
    "direction",
    "display",
    "divisor",
    "dominant-baseline",
    "dur",
    "dx",
    "dy",
    "edge",
    "elevation",
    "end",
    "exponent",
    "fill",
    "fill-opacity",
    "fill-rule",
    "filter",
    "filterunits",
    "flood-color",
    "flood-opacity",
    "font-family",
    "font-size",
    "font-size-adjust",
    "font-stretch",
    "font-style",
    "font-variant",
    "font-weight",
    "fx",
    "fy",
    "g1",
    "g2",
    "glyph-name",
    "glyph-orientation-horizontal",
    "glyph-orientation-vertical",
    "glyphref",
    "gradienttransform",
    "gradientunits",
    "hanging",
    "height",
    "horiz-adv-x",
    "horiz-origin-x",
    "href",
    "id",
    "ideographic",
    "image-rendering",
    "in",
    "in2",
    "intercept",
    "k",
    "k1",
    "k2",
    "k3",
    "k4",
    "kernelmatrix",
    "kernelunitlength",
    "kerning",
    "keypoints",
    "keysplines",
    "keytimes",
    "lang",
    "lengthadjust",
    "letter-spacing",
    "lighting-color",
    "limitingconeangle",
    "local",
    "marker-end",
    "marker-mid",
    "marker-start",
    "markerheight",
    "markerunits",
    "markerwidth",
    "mask",
    "maskcontentunits",
    "maskunits",
    "mathematical",
    "media",
    "method",
    "mode",
    "name",
    "numoctaves",
    "offset",
    "opacity",
    "operator",
    "order",
    "orient",
    "orientation",
    "origin",
    "overflow",
    "overline-position",
    "overline-thickness",
    "panose-1",
    "path",
    "pathlength",
    "patterncontentunits",
    "patterntransform",
    "patternunits",
    "points",
    "pointer-events",
    "pointsatx",
    "pointsaty",
    "pointsatz",
    "preservealpha",
    "preserveaspectratio",
    "primitiveunits",
    "r",
    "radius",
    "refx",
    "refy",
    "rendering-intent",
    "repeatcount",
    "repeatdur",
    "requiredextensions",
    "requiredfeatures",
    "restart",
    "result",
    "role",
    "rotate",
    "rx",
    "ry",
    "scale",
    "seed",
    "shape-rendering",
    "slope",
    "spacing",
    "specularconstant",
    "specularexponent",
    "spreadmethod",
    "startoffset",
    "stddeviation",
    "stemh",
    "stemv",
    "stitchtiles",
    "stop-color",
    "stop-opacity",
    "strikethrough-position",
    "strikethrough-thickness",
    "stroke",
    "stroke-dasharray",
    "stroke-dashoffset",
    "stroke-linecap",
    "stroke-linejoin",
    "stroke-miterlimit",
    "stroke-opacity",
    "stroke-width",
    "style",
    "surfacescale",
    "systemlanguage",
    "tabindex",
    "tablevalues",
    "targetx",
    "targety",
    "text-anchor",
    "text-decoration",
    "text-rendering",
    "textlength",
    "to",
    "transform",
    "transform-origin",
    "type",
    "u1",
    "u2",
    "underline-position",
    "underline-thickness",
    "unicode",
    "unicode-bidi",
    "unicode-range",
    "units-per-em",
    "v-alphabetic",
    "v-hanging",
    "v-ideographic",
    "v-mathematical",
    "values",
    "version",
    "vert-adv-y",
    "vert-origin-x",
    "vert-origin-y",
    "viewbox",
    "visibility",
    "width",
    "widths",
    "word-spacing",
    "writing-mode",
    "x",
    "x-height",
    "x1",
    "x2",
    "xchannelselector",
    "y",
    "y1",
    "y2",
    "ychannelselector",
    "z",
    "zoomandpan",
];

fn sanitize_svg_result(svg: &str) -> Result<String, String> {
    let document = roxmltree::Document::parse(svg)
        .map_err(|error| format!("The renderer result is not valid SVG: {error}"))?;
    let root = document.root_element();
    if root.tag_name().name() != "svg" || root.tag_name().namespace() != Some(SVG_NS) {
        return Err("The renderer result is not an SVG document.".into());
    }
    let mut output = String::with_capacity(svg.len().min(MAX_SVG_BYTES));
    write_svg_element(root, &mut output, true, 0)?;
    Ok(output)
}

fn write_svg_element(
    node: Node<'_, '_>,
    output: &mut String,
    root: bool,
    depth: usize,
) -> Result<(), String> {
    if depth > MAX_SVG_DEPTH {
        return Err("The renderer result is nested too deeply.".into());
    }
    let tag = node.tag_name().name();
    let lower = tag.to_ascii_lowercase();
    if DANGEROUS_SVG_TAGS.contains(&lower.as_str()) {
        return Err(format!(
            "The renderer result contains an unsupported <{tag}> element."
        ));
    }
    if !root && !SAFE_SVG_TAGS.contains(&lower.as_str()) {
        return Ok(());
    }
    if node.tag_name().namespace() != Some(SVG_NS) {
        return Ok(());
    }

    output.push('<');
    output.push_str(tag);
    if root {
        output.push_str(" xmlns=\"http://www.w3.org/2000/svg\"");
        output.push_str(" xmlns:xlink=\"http://www.w3.org/1999/xlink\"");
    }
    for attribute in node.attributes() {
        let local = attribute.name();
        let name_lower = local.to_ascii_lowercase();
        if name_lower == "xmlns" || name_lower.starts_with("xmlns:") {
            continue;
        }
        if name_lower.starts_with("on") {
            continue;
        }
        let namespace = attribute.namespace();
        if namespace == Some(XML_NS) {
            if !matches!(name_lower.as_str(), "space" | "lang") {
                continue;
            }
        } else if namespace == Some(XLINK_NS) {
            if name_lower != "href" {
                continue;
            }
        } else if namespace.is_some() {
            continue;
        }

        let output_name = if namespace == Some(XLINK_NS) {
            format!("xlink:{local}")
        } else if namespace == Some(XML_NS) {
            format!("xml:{local}")
        } else {
            local.to_string()
        };

        if name_lower == "href" {
            if !valid_local_fragment(attribute.value()) {
                return Err("The renderer result contains an external link.".into());
            }
        } else if name_lower == "src" {
            return Err("The renderer result contains an external source.".into());
        } else if name_lower == "style" || URL_ATTRIBUTES.contains(&name_lower.as_str()) {
            let sanitized = sanitize_css(attribute.value())?;
            if sanitized.trim().is_empty() {
                continue;
            }
            output.push(' ');
            output.push_str(&output_name);
            output.push_str("=\"");
            escape_attribute(&sanitized, output);
            output.push('"');
            continue;
        } else if namespace == Some(XML_NS) {
            // xml:space / xml:lang are safe metadata.
        } else if !SAFE_SVG_ATTRIBUTES.contains(&name_lower.as_str())
            && !name_lower.starts_with("aria-")
        {
            continue;
        }

        output.push(' ');
        output.push_str(&output_name);
        output.push_str("=\"");
        escape_attribute(attribute.value(), output);
        output.push('"');
    }
    output.push('>');

    if lower == "style" {
        let css = sanitize_css(node.text().unwrap_or_default())?;
        escape_text(&css, output);
    } else {
        for child in node.children() {
            if child.is_element() {
                write_svg_element(child, output, false, depth + 1)?;
            } else if child.is_text() {
                escape_text(child.text().unwrap_or_default(), output);
            }
        }
    }
    output.push_str("</");
    output.push_str(tag);
    output.push('>');
    Ok(())
}

fn valid_local_fragment(value: &str) -> bool {
    let Some(fragment) = value.strip_prefix('#') else {
        return false;
    };
    !fragment.is_empty()
        && !fragment.chars().any(|character| {
            character.is_whitespace()
                || character.is_control()
                || matches!(character, '"' | '\'' | '(' | ')' | '<' | '>' | '\\')
        })
}

fn normalize_scheme_text(value: &str) -> String {
    value
        .chars()
        .filter(|character| !character.is_ascii_control() && !character.is_ascii_whitespace())
        .map(|character| character.to_ascii_lowercase())
        .collect()
}

fn contains_external_scheme(value: &str) -> bool {
    let lower = normalize_scheme_text(value);
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
    .any(|scheme| lower.starts_with(scheme) || lower.contains(scheme))
        || lower.contains("://")
        || lower.starts_with("//")
}

/// Linear CSS tokenizer/sanitizer used on the trusted side. It replaces
/// comments with whitespace (never empty text, so tokens cannot be joined),
/// neutralises non-local url() arguments, rejects unsafe image-set()/import
/// constructs, and preserves ordinary selectors, declarations, colours, and
/// local fragment references Mermaid emits.
fn sanitize_css(input: &str) -> Result<String, String> {
    let mut parser = Parser::new(input);
    let mut output = String::with_capacity(input.len());
    sanitize_css_block(&mut parser, input, &mut output, 0)
        .map_err(|message| message.to_string())?;
    Ok(output)
}

fn sanitize_css_block<'i>(
    parser: &mut Parser<'i>,
    input: &'i str,
    output: &mut String,
    depth: usize,
) -> Result<(), &'static str> {
    if depth > MAX_CSS_NESTING {
        return Err("The renderer result contains deeply nested CSS.");
    }
    let mut scheme_candidate = false;
    let mut slash_seen = false;
    loop {
        let start = parser.position().byte_index();
        let token = match parser.next_including_whitespace_and_comments() {
            Ok(token) => token.clone(),
            Err(error) if matches!(error.kind, BasicParseErrorKind::EndOfInput) => break,
            Err(_) => return Err("The renderer result contains malformed CSS."),
        };
        let end = parser.position().byte_index();
        let source = &input[start..end];
        match token {
            Token::Comment(_) => {
                // A space is significant: removing comments must never join
                // surrounding tokens into url()/scheme tokens.
                output.push(' ');
                scheme_candidate = false;
                slash_seen = false;
            }
            Token::UnquotedUrl(value) => {
                if valid_local_fragment(value.as_ref()) {
                    output.push_str(source);
                } else {
                    output.push_str("none");
                }
                scheme_candidate = false;
                slash_seen = false;
            }
            Token::QuotedString(value) => {
                if contains_external_scheme(value.as_ref()) {
                    return Err("The renderer result contains an external CSS string.");
                }
                output.push_str(source);
                scheme_candidate = false;
                slash_seen = false;
            }
            Token::Function(name) if name.as_ref().eq_ignore_ascii_case("url") => {
                if let Some(fragment) = sanitize_url_function(parser, input, depth + 1)? {
                    output.push_str("url(\"");
                    output.push_str(&fragment);
                    output.push_str("\")");
                } else {
                    output.push_str("none");
                }
                scheme_candidate = false;
                slash_seen = false;
            }
            Token::Function(name) => {
                let lower = name.as_ref().to_ascii_lowercase();
                if source.contains('\\')
                    || matches!(
                        lower.as_str(),
                        "expression"
                            | "image-set"
                            | "-webkit-image-set"
                            | "cross-fade"
                            | "-webkit-cross-fade"
                            | "element"
                            | "-moz-binding"
                    )
                {
                    return Err("The renderer result contains an unsafe CSS function.");
                }
                output.push_str(source);
                sanitize_nested_css(parser, input, output, depth + 1)?;
                output.push(')');
                scheme_candidate = false;
                slash_seen = false;
            }
            Token::ParenthesisBlock => {
                output.push_str(source);
                sanitize_nested_css(parser, input, output, depth + 1)?;
                output.push(')');
                scheme_candidate = false;
                slash_seen = false;
            }
            Token::SquareBracketBlock => {
                output.push_str(source);
                sanitize_nested_css(parser, input, output, depth + 1)?;
                output.push(']');
                scheme_candidate = false;
                slash_seen = false;
            }
            Token::CurlyBracketBlock => {
                output.push_str(source);
                sanitize_nested_css(parser, input, output, depth + 1)?;
                output.push('}');
                scheme_candidate = false;
                slash_seen = false;
            }
            Token::AtKeyword(name) => {
                let lower = name.as_ref().to_ascii_lowercase();
                if !matches!(
                    lower.as_str(),
                    "media" | "supports" | "keyframes" | "-webkit-keyframes"
                ) {
                    return Err("The renderer result contains an unsafe CSS at-rule.");
                }
                output.push_str(source);
                scheme_candidate = false;
                slash_seen = false;
            }
            Token::BadUrl(_) | Token::BadString(_) => {
                return Err("The renderer result contains malformed CSS.");
            }
            Token::Delim('\\') => {
                return Err("The renderer result contains an unsafe CSS escape.");
            }
            Token::Ident(name) => {
                let lower = normalize_scheme_text(name.as_ref());
                scheme_candidate = matches!(
                    lower.as_str(),
                    "http" | "https" | "data" | "javascript" | "blob" | "filesystem" | "file"
                );
                slash_seen = false;
                output.push_str(source);
            }
            Token::Colon if scheme_candidate => {
                return Err("The renderer result contains an external CSS scheme.");
            }
            Token::Delim('/') if slash_seen => {
                return Err("The renderer result contains a protocol-relative CSS URL.");
            }
            other => {
                if !matches!(other, Token::WhiteSpace(_)) {
                    scheme_candidate = false;
                }
                slash_seen = matches!(other, Token::Delim('/'));
                output.push_str(source);
            }
        }
    }
    Ok(())
}

fn sanitize_nested_css<'i>(
    parser: &mut Parser<'i>,
    input: &'i str,
    output: &mut String,
    depth: usize,
) -> Result<(), &'static str> {
    let mut inner_error = None;
    let result = parser.parse_nested_block(|nested| {
        if let Err(message) = sanitize_css_block(nested, input, output, depth) {
            inner_error = Some(message);
        }
        Ok::<(), ParseError<&'static str>>(())
    });
    if let Some(message) = inner_error {
        return Err(message);
    }
    result.map_err(|_| "The renderer result contains malformed CSS.")?;
    Ok(())
}

/// A url() function, quoted or not, contributes output only when its entire
/// argument is a local fragment reference. Everything else becomes `none`.
fn sanitize_url_function<'i>(
    parser: &mut Parser<'i>,
    _input: &'i str,
    depth: usize,
) -> Result<Option<String>, &'static str> {
    if depth > MAX_CSS_NESTING {
        return Err("The renderer result contains deeply nested CSS.");
    }
    let mut fragment = None;
    let mut invalid = false;
    let result = parser.parse_nested_block(|nested| {
        loop {
            let token = match nested.next_including_whitespace_and_comments() {
                Ok(token) => token.clone(),
                Err(error) if matches!(error.kind, BasicParseErrorKind::EndOfInput) => break,
                Err(_) => {
                    invalid = true;
                    break;
                }
            };
            match token {
                Token::Comment(_) | Token::WhiteSpace(_) => {}
                Token::QuotedString(value) if fragment.is_none() => {
                    if valid_local_fragment(value.as_ref()) {
                        fragment = Some(value.as_ref().to_string());
                    } else {
                        invalid = true;
                        break;
                    }
                }
                Token::UnquotedUrl(value) if fragment.is_none() => {
                    if valid_local_fragment(value.as_ref()) {
                        fragment = Some(value.as_ref().to_string());
                    } else {
                        invalid = true;
                        break;
                    }
                }
                Token::IDHash(value) if fragment.is_none() => {
                    let candidate = format!("#{}", value.as_ref());
                    if valid_local_fragment(&candidate) {
                        fragment = Some(candidate);
                    } else {
                        invalid = true;
                        break;
                    }
                }
                Token::Hash(value) if fragment.is_none() => {
                    let candidate = format!("#{}", value.as_ref());
                    if valid_local_fragment(&candidate) {
                        fragment = Some(candidate);
                    } else {
                        invalid = true;
                        break;
                    }
                }
                _ => {
                    invalid = true;
                    break;
                }
            }
        }
        Ok::<(), ParseError<&'static str>>(())
    });
    if result.is_err() {
        return Err("The renderer result contains malformed CSS.");
    }
    if invalid || fragment.is_none() {
        Ok(None)
    } else {
        Ok(fragment)
    }
}

fn escape_text(value: &str, output: &mut String) {
    for character in value.chars() {
        match character {
            '&' => output.push_str("&amp;"),
            '<' => output.push_str("&lt;"),
            '>' => output.push_str("&gt;"),
            character => output.push(character),
        }
    }
}

fn escape_attribute(value: &str, output: &mut String) {
    for character in value.chars() {
        match character {
            '&' => output.push_str("&amp;"),
            '<' => output.push_str("&lt;"),
            '>' => output.push_str("&gt;"),
            '"' => output.push_str("&quot;"),
            character => output.push(character),
        }
    }
}

/// Both helper functions are used as the first statement of every protected
/// command, before any filesystem/document work or dialog opens.
pub fn ensure_main(label: &str) -> Result<(), String> {
    if label == MAIN_LABEL {
        Ok(())
    } else {
        Err("This command is only available to the main Folio window.".into())
    }
}

pub fn ensure_renderer(label: &str) -> Result<(), String> {
    if label == RENDERER_LABEL {
        Ok(())
    } else {
        Err("This command is only available to the offline diagram renderer.".into())
    }
}

/// Applies the renderer-only CSP to the renderer HTML response. The HTML also
/// carries the same policy in a meta tag so development servers that bypass
/// `on_web_resource_request` still enforce it before scripts execute.
pub fn apply_renderer_csp(request: Request<Vec<u8>>, response: &mut Response<Cow<'static, [u8]>>) {
    if request.uri().path().ends_with("mermaid-renderer.html")
        || response.headers().contains_key(CONTENT_SECURITY_POLICY)
    {
        response.headers_mut().insert(
            CONTENT_SECURITY_POLICY,
            HeaderValue::from_static(RENDERER_CSP),
        );
    }
}

/// Builds the hidden, separately labelled renderer webview. The window is
/// created lazily on the first diagram render so plain documents never start
/// Mermaid or a second webview.
pub fn build_window(app: &tauri::AppHandle) -> tauri::Result<WebviewWindow> {
    WebviewWindowBuilder::new(
        app,
        RENDERER_LABEL,
        WebviewUrl::App("mermaid-renderer.html".into()),
    )
    .title("Folio diagram renderer")
    .inner_size(1.0, 1.0)
    .visible(false)
    .focused(false)
    .skip_taskbar(true)
    .decorations(false)
    .resizable(false)
    .on_navigation(|url| {
        (url.scheme() == "about" && url.path() == "blank")
            || (crate::is_app_navigation(url) && url.path().ends_with("mermaid-renderer.html"))
    })
    .on_web_resource_request(apply_renderer_csp)
    .build()
}

/// Debug-only native evidence path. It drives the real application windows,
/// ACL, caller gates, and transport under an isolated display:
///
/// ```sh
/// FOLIO_NATIVE_PROBE=1 xvfb-run -a ./target/debug/folio
/// ```
///
/// No release endpoint is registered and no release-only code is included.
#[cfg(debug_assertions)]
pub fn spawn_native_probe(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let code = run_native_probe(&app);
        app.exit(code);
    });
}

#[cfg(debug_assertions)]
fn run_native_probe(app: &tauri::AppHandle) -> i32 {
    use std::fs;

    let temp = match tempfile::tempdir() {
        Ok(temp) => temp,
        Err(error) => {
            println!("FOLIO_NATIVE_PROBE_FAIL could not create temp directory: {error}");
            return 1;
        }
    };
    let main_dir = temp.path().join("main");
    let other_dir = temp.path().join("other");
    let setup = (|| -> Result<(), String> {
        fs::create_dir_all(&main_dir).map_err(|error| error.to_string())?;
        fs::create_dir_all(&other_dir).map_err(|error| error.to_string())?;
        fs::write(main_dir.join("note.md"), "# Main\n").map_err(|error| error.to_string())?;
        fs::write(main_dir.join("child.md"), "# Main child\n")
            .map_err(|error| error.to_string())?;
        fs::write(other_dir.join("note.md"), "# Other\n").map_err(|error| error.to_string())?;
        fs::write(other_dir.join("child.md"), "# Other child\n")
            .map_err(|error| error.to_string())?;
        Ok(())
    })();
    if let Err(error) = setup {
        println!("FOLIO_NATIVE_PROBE_FAIL could not create fixtures: {error}");
        return 1;
    }
    let canonical = |path: &std::path::Path| {
        path.canonicalize()
            .unwrap_or_else(|_| path.to_path_buf())
            .to_string_lossy()
            .into_owned()
    };
    let main_dir = canonical(&main_dir);
    let other_dir = canonical(&other_dir);
    let main_path = canonical(&std::path::Path::new(&main_dir).join("note.md"));
    let other_path = canonical(&std::path::Path::new(&other_dir).join("note.md"));

    let Some(main) = app.get_webview_window(MAIN_LABEL) else {
        println!("FOLIO_NATIVE_PROBE_FAIL main webview missing");
        return 1;
    };
    let Some(renderer) = app.get_webview_window(RENDERER_LABEL) else {
        println!("FOLIO_NATIVE_PROBE_FAIL renderer webview missing");
        return 1;
    };

    if !wait_until(
        &main,
        "!!window.__TAURI__ && document.readyState === 'complete'",
        Duration::from_secs(30),
    ) {
        println!("FOLIO_NATIVE_PROBE_FAIL main webview did not become ready");
        return 1;
    }
    if !wait_until(
        &renderer,
        "!!window.__TAURI__ && !!window.FolioMermaidRenderer && document.readyState === 'complete'",
        Duration::from_secs(30),
    ) {
        println!("FOLIO_NATIVE_PROBE_FAIL renderer webview did not become ready");
        return 1;
    }

    let probe_script = include_str!("../tests/native-tauri-probe.js");
    for (name, window) in [("main", &main), ("renderer", &renderer)] {
        if let Err(error) = window.eval(probe_script) {
            println!("FOLIO_NATIVE_PROBE_FAIL could not inject {name} probe: {error}");
            return 1;
        }
    }
    let data = format!(
        "window.__folioProbeData = {{mainPath: {}, mainDir: {}, otherPath: {}, otherDir: {}}};",
        js_string(&main_path),
        js_string(&main_dir),
        js_string(&other_path),
        js_string(&other_dir),
    );
    for (name, window) in [("main", &main), ("renderer", &renderer)] {
        if let Err(error) = window.eval(data.clone()) {
            println!("FOLIO_NATIVE_PROBE_FAIL could not inject {name} data: {error}");
            return 1;
        }
    }

    if let Err(error) = main.eval("window.__folioNativeProbe.mainPrepare();") {
        println!("FOLIO_NATIVE_PROBE_FAIL could not start main probe: {error}");
        return 1;
    }
    let Some(main_prepared) = wait_phase(&main, "main-prepared", Duration::from_secs(30)) else {
        println!("FOLIO_NATIVE_PROBE_FAIL main prepare timed out");
        return 1;
    };
    println!("FOLIO_NATIVE_PROBE main-prepared: {main_prepared}");
    if !report_pass(&main_prepared) {
        println!("FOLIO_NATIVE_PROBE_FAIL main prepare reported failure");
        return 1;
    }

    if let Err(error) = renderer.eval("window.__folioNativeProbe.rendererProbe();") {
        println!("FOLIO_NATIVE_PROBE_FAIL could not start renderer probe: {error}");
        return 1;
    }
    let Some(renderer_report) = wait_phase(&renderer, "renderer", Duration::from_secs(60)) else {
        println!("FOLIO_NATIVE_PROBE_FAIL renderer probe timed out");
        return 1;
    };
    println!("FOLIO_NATIVE_PROBE renderer: {renderer_report}");
    if !report_pass(&renderer_report) {
        println!("FOLIO_NATIVE_PROBE_FAIL renderer reported a non-denial or transport failure");
        return 1;
    }

    if let Err(error) = main.eval("window.__folioNativeProbe.mainFinal();") {
        println!("FOLIO_NATIVE_PROBE_FAIL could not start final roundtrip: {error}");
        return 1;
    }
    let Some(main_final) = wait_phase(&main, "main-final", Duration::from_secs(40)) else {
        println!("FOLIO_NATIVE_PROBE_FAIL final roundtrip timed out");
        return 1;
    };
    println!("FOLIO_NATIVE_PROBE main-final: {main_final}");
    if !report_pass(&main_final) {
        println!("FOLIO_NATIVE_PROBE_FAIL final roundtrip reported failure");
        return 1;
    }

    // Lifecycle: cancel an active (hung) render, then retry immediately while
    // the renderer is being recycled. The retry must fail explicitly or wait
    // for the rebuilt renderer, never attach to the doomed window and hang.
    if let Err(error) = renderer.eval("window.__folioNativeProbe.rendererInstallHang();") {
        println!("FOLIO_NATIVE_PROBE_FAIL could not install hang probe: {error}");
        return 1;
    }
    if !wait_until(
        &renderer,
        "window.__folioHangReady === true",
        Duration::from_secs(10),
    ) {
        println!("FOLIO_NATIVE_PROBE_FAIL hang probe did not initialize");
        return 1;
    }
    if let Err(error) = main.eval("window.__folioNativeProbe.mainStartHang();") {
        println!("FOLIO_NATIVE_PROBE_FAIL could not start hung render: {error}");
        return 1;
    }
    let Some(hang_started) = wait_phase(&main, "main-hang", Duration::from_secs(20)) else {
        println!("FOLIO_NATIVE_PROBE_FAIL hung render was not submitted");
        return 1;
    };
    println!("FOLIO_NATIVE_PROBE main-hang: {hang_started}");
    if !report_pass(&hang_started) {
        println!("FOLIO_NATIVE_PROBE_FAIL hung render submission failed");
        return 1;
    }
    if !wait_until(
        &renderer,
        "window.__folioProbeSeen === 'native-hang'",
        Duration::from_secs(10),
    ) {
        println!("FOLIO_NATIVE_PROBE_FAIL renderer did not receive the hung render");
        return 1;
    }
    if let Err(error) = main.eval("window.__folioNativeProbe.mainCancelAndRetry();") {
        println!("FOLIO_NATIVE_PROBE_FAIL could not run cancel/retry probe: {error}");
        return 1;
    }
    let Some(recycle_report) = wait_phase(&main, "main-recycle", Duration::from_secs(40)) else {
        println!("FOLIO_NATIVE_PROBE_FAIL cancel/retry probe timed out");
        return 1;
    };
    println!("FOLIO_NATIVE_PROBE main-recycle: {recycle_report}");
    if !report_pass(&recycle_report) {
        println!("FOLIO_NATIVE_PROBE_FAIL cancel/retry did not recover");
        return 1;
    }

    let main_after = fs::read_to_string(&main_path).unwrap_or_default();
    let other_after = fs::read_to_string(&other_path).unwrap_or_default();
    let files_unchanged = main_after == "# Main\n" && other_after == "# Other\n";
    println!(
        "FOLIO_NATIVE_PROBE files main={:?} other={:?} unchanged={files_unchanged}",
        main_after, other_after
    );
    if !files_unchanged {
        println!("FOLIO_NATIVE_PROBE_FAIL renderer mutated a document file");
        return 1;
    }

    println!("FOLIO_NATIVE_PROBE_PASS");
    0
}

#[cfg(debug_assertions)]
fn eval_json(window: &WebviewWindow, script: &str) -> Option<String> {
    let (sender, receiver) = std::sync::mpsc::channel();
    window
        .eval_with_callback(script.to_string(), move |value| {
            let _ = sender.send(value);
        })
        .ok()?;
    receiver.recv_timeout(Duration::from_secs(3)).ok()
}

#[cfg(debug_assertions)]
fn compact_json(value: &str) -> String {
    value
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect()
}

#[cfg(debug_assertions)]
fn wait_until(window: &WebviewWindow, script: &str, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if let Some(value) = eval_json(window, script) {
            let compact = compact_json(&value);
            if compact == "true" || compact == "\"true\"" {
                return true;
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    false
}

#[cfg(debug_assertions)]
fn wait_phase(window: &WebviewWindow, phase: &str, timeout: Duration) -> Option<String> {
    let deadline = Instant::now() + timeout;
    let needle = format!("\"phase\":\"{phase}\"");
    while Instant::now() < deadline {
        if let Some(value) = eval_json(window, "window.__folioProbeResult || null") {
            if compact_json(&value).contains(&needle) {
                return Some(value);
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    None
}

#[cfg(debug_assertions)]
fn report_pass(report: &str) -> bool {
    compact_json(report).contains("\"pass\":true")
}

#[cfg(debug_assertions)]
fn js_string(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len() + 2);
    escaped.push('"');
    for character in value.chars() {
        match character {
            '\\' => escaped.push_str("\\\\"),
            '"' => escaped.push_str("\\\""),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            '\t' => escaped.push_str("\\t"),
            character if character.is_control() => {
                escaped.push_str(&format!("\\u{:04x}", character as u32));
            }
            character => escaped.push(character),
        }
    }
    escaped.push('"');
    escaped
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(id: &str) -> RenderRequest {
        RenderRequest {
            id: id.into(),
            source: "flowchart TD\nA-->B".into(),
            theme: RendererTheme::default(),
        }
    }

    fn svg() -> String {
        "<svg xmlns=\"http://www.w3.org/2000/svg\"><g><path d=\"M0 0\"/></g></svg>".into()
    }

    #[test]
    fn only_the_main_webview_passes_the_main_gate() {
        assert!(ensure_main(MAIN_LABEL).is_ok());
        assert!(ensure_main(RENDERER_LABEL).is_err());
        assert!(ensure_main("other").is_err());
    }

    #[test]
    fn only_the_renderer_webview_passes_the_renderer_gate() {
        assert!(ensure_renderer(RENDERER_LABEL).is_ok());
        assert!(ensure_renderer(MAIN_LABEL).is_err());
        assert!(ensure_renderer("main-window").is_err());
    }

    #[test]
    fn rejects_malformed_ids_before_recording_work() {
        for id in ["", "has space", "a/b", "../escape", "ünïcode"] {
            let mut transport = Transport::default();
            assert_eq!(
                transport.submit(request(id)),
                Err(TransportError::InvalidId),
                "{id:?}"
            );
            assert!(transport.is_empty());
        }
        assert!(Transport::default().submit(request("mermaid-42")).is_ok());
    }

    #[test]
    fn rejects_oversized_source_and_themes() {
        let mut transport = Transport::default();
        let mut oversized = request("mermaid-1");
        oversized.source = "x".repeat(MAX_SOURCE_BYTES + 1);
        assert_eq!(
            transport.submit(oversized),
            Err(TransportError::SourceTooLarge)
        );

        let mut unsafe_theme = request("mermaid-2");
        unsafe_theme.theme.variables.insert(
            "background".into(),
            ThemeValue::Text("url(https://example.com/bg.png)".into()),
        );
        assert_eq!(
            transport.submit(unsafe_theme),
            Err(TransportError::InvalidTheme)
        );
        assert!(transport.is_empty());
    }

    #[test]
    fn duplicate_and_excess_requests_are_rejected_without_mutation() {
        let mut transport = Transport::default();
        assert_eq!(transport.submit(request("mermaid-1")), Ok(false));
        assert_eq!(
            transport.submit(request("mermaid-1")),
            Err(TransportError::DuplicateId)
        );
        assert_eq!(transport.len(), 1);

        for index in 0..(MAX_OUTSTANDING_REQUESTS - 1) {
            transport
                .submit(request(&format!("mermaid-extra-{index}")))
                .unwrap();
        }
        assert_eq!(
            transport.submit(request("mermaid-overflow")),
            Err(TransportError::TooManyRequests)
        );
        assert_eq!(transport.len(), MAX_OUTSTANDING_REQUESTS);
    }

    #[test]
    fn readiness_dispatches_pending_requests_once() {
        let mut transport = Transport::default();
        transport.submit(request("mermaid-1")).unwrap();
        let dispatched = transport.mark_ready();
        assert_eq!(dispatched.len(), 1);
        assert_eq!(dispatched[0].id, "mermaid-1");
        assert!(transport.mark_ready().len() == 1);
        assert_eq!(transport.len(), 1);
    }

    #[test]
    fn result_before_dispatch_and_unknown_ids_are_rejected() {
        let mut transport = Transport::default();
        transport.submit(request("mermaid-1")).unwrap();
        assert_eq!(
            transport.accept(
                "mermaid-1",
                RenderResult {
                    svg: Some(svg()),
                    error: None
                }
            ),
            Err(TransportError::NotDispatched)
        );
        assert_eq!(
            transport.accept(
                "missing",
                RenderResult {
                    svg: Some(svg()),
                    error: None
                }
            ),
            Err(TransportError::UnknownRequest)
        );
    }

    #[test]
    fn accepts_one_sanitized_result_then_rejects_duplicates() {
        let mut transport = Transport::default();
        transport.submit(request("mermaid-1")).unwrap();
        transport.mark_ready();
        let outcome = transport
            .accept(
                "mermaid-1",
                RenderResult {
                    svg: Some(svg()),
                    error: None,
                },
            )
            .unwrap();
        match outcome {
            AcceptOutcome::Accepted(event) => {
                assert!(event.ok);
                assert!(event.sanitized);
                assert_eq!(event.id, "mermaid-1");
            }
            AcceptOutcome::Rejected { .. } => panic!("result should be accepted"),
        }
        assert!(transport.is_empty());
        assert_eq!(
            transport.accept(
                "mermaid-1",
                RenderResult {
                    svg: Some(svg()),
                    error: None
                }
            ),
            Err(TransportError::UnknownRequest)
        );
        assert_eq!(
            transport.accept(
                "has space",
                RenderResult {
                    svg: Some(svg()),
                    error: None
                }
            ),
            Err(TransportError::InvalidId)
        );
    }

    #[test]
    fn plain_text_urls_and_svg_namespaces_are_not_treated_as_network_attributes() {
        let text =
            "<svg xmlns=\"http://www.w3.org/2000/svg\"><text>https://example.com/read</text></svg>";
        let event = validate_result(
            "mermaid-1",
            RenderResult {
                svg: Some(text.into()),
                error: None,
            },
        )
        .unwrap();
        assert!(event.ok);
        assert!(event
            .svg
            .as_deref()
            .is_some_and(|svg| svg.contains("https://example.com/read")));
    }

    #[test]
    fn trusted_sanitizer_neutralises_css_comment_token_join() {
        let malicious = r#"<svg xmlns="http://www.w3.org/2000/svg"><rect style="background-image:u/**/rl(h/**/ttps:example.com/leak.png)"/></svg>"#;
        let sanitized = sanitize_svg_result(malicious).unwrap();
        let lower = sanitized.to_ascii_lowercase();
        assert_eq!(
            sanitized,
            include_str!("../tests/fixtures/native-sanitized-comment-bypass.svg")
        );
        assert!(
            !lower.contains("url("),
            "comments must become spaces, not vanish"
        );
        assert!(!lower.contains("https:"), "joined scheme must not survive");
        assert!(
            lower.contains("u rl("),
            "the comment must leave a separator"
        );
    }

    #[test]
    fn trusted_sanitizer_neutralises_external_css_urls() {
        for malicious in [
            r#"<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:url(https://example.com/a.png)"/></svg>"#,
            r#"<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(//example.com/a.png)"/></svg>"#,
            r#"<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:url(h/**/ttps://example.com/a.png)"/></svg>"#,
            r#"<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:url(/**/https://example.com/a.png)"/></svg>"#,
        ] {
            let sanitized = sanitize_svg_result(malicious)
                .unwrap_or_else(|error| panic!("must neutralise {malicious}: {error}"));
            let lower = sanitized
                .to_ascii_lowercase()
                .replace("http://www.w3.org/2000/svg", "")
                .replace("http://www.w3.org/1999/xlink", "");
            assert!(
                !lower.contains("url("),
                "sanitized CSS must not keep a URL: {sanitized}"
            );
            assert!(
                !lower.contains("http"),
                "sanitized CSS must not keep a scheme: {sanitized}"
            );
            assert!(
                !lower.contains("example.com"),
                "sanitized CSS must not keep the host: {sanitized}"
            );
            assert!(lower.contains("none"), "URL must become none: {sanitized}");
        }
    }

    #[test]
    fn trusted_sanitizer_rejects_unsafe_elements_and_malformed_css_functions() {
        for malicious in [
            r#"<svg xmlns="http://www.w3.org/2000/svg"><use href="https://example.com/a.svg"/></svg>"#,
            r##"<svg xmlns="http://www.w3.org/2000/svg"><image href="#local"/></svg>"##,
            r#"<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div>x</div></foreignObject></svg>"#,
            r#"<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>"#,
            r#"<svg xmlns="http://www.w3.org/2000/svg"><style>@import "https://example.com/a.css";</style></svg>"#,
            r#"<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:u/**/rl(//example.com/a.png)"/></svg>"#,
            r##"<svg xmlns="http://www.w3.org/2000/svg"><rect style='background-image:image("ht\a tps:example.com/p.png")'/></svg>"##,
        ] {
            assert!(
                sanitize_svg_result(malicious).is_err(),
                "must reject {malicious}"
            );
        }
    }

    #[test]
    fn trusted_sanitizer_neutralises_escaped_quoted_url_scheme() {
        let malicious = r##"<svg xmlns="http://www.w3.org/2000/svg"><rect style='background-image:url("ht\a tps:example.com/p.png")'/></svg>"##;
        let sanitized = sanitize_svg_result(malicious).unwrap();
        assert_eq!(
            sanitized,
            include_str!("../tests/fixtures/native-sanitized-escaped-url.svg")
        );
        let lower = sanitized
            .to_ascii_lowercase()
            .replace("http://www.w3.org/2000/svg", "")
            .replace("http://www.w3.org/1999/xlink", "");
        assert!(!lower.contains("url("));
        assert!(!lower.contains("http"));
        assert!(!lower.contains("example.com"));
    }

    #[test]
    fn trusted_sanitizer_preserves_local_references_and_removes_events() {
        let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs><g fill="url(#g)" onclick="alert(1)"><path d="M0 0"/><use href="#g"/></g></svg>"##;
        let sanitized = sanitize_svg_result(svg).unwrap();
        assert!(sanitized.contains("url(#g)"));
        assert!(sanitized.contains("href=\"#g\""));
        assert!(!sanitized.to_ascii_lowercase().contains("onload"));
        assert!(!sanitized.to_ascii_lowercase().contains("onclick"));
        assert!(sanitized.contains("linearGradient"));
        assert!(sanitized.contains("xmlns=\"http://www.w3.org/2000/svg\""));
    }

    #[test]
    fn css_sanitizer_is_linear_on_large_input() {
        let mut css = String::with_capacity(256 * 1024 + 64);
        while css.len() < 256 * 1024 {
            css.push_str("fill:#fff;stroke:#000;");
        }
        css.push_str("background-image:u/**/rl(https://example.com/leak.png);");
        let started = Instant::now();
        assert!(sanitize_css(&css).is_err());
        let elapsed = started.elapsed();
        println!("256 KiB CSS sanitizer: {elapsed:?}");
        assert!(
            elapsed < Duration::from_secs(3),
            "CSS sanitization should be linear, not quadratic"
        );
    }

    #[test]
    fn oversized_and_forbidden_results_are_rejected_and_cleaned_up() {
        for bad in [
            "x".repeat(MAX_SVG_BYTES + 1),
            "<svg><script>alert(1)</script></svg>".into(),
            "<svg><image href=\"https://example.com/a.png\"/></svg>".into(),
            "<html>not svg</html>".into(),
        ] {
            let mut transport = Transport::default();
            transport.submit(request("mermaid-1")).unwrap();
            transport.mark_ready();
            let outcome = transport
                .accept(
                    "mermaid-1",
                    RenderResult {
                        svg: Some(bad),
                        error: None,
                    },
                )
                .unwrap();
            match outcome {
                AcceptOutcome::Rejected { id, failure } => {
                    assert_eq!(id, "mermaid-1");
                    assert_eq!(failure.code, "invalid_result");
                }
                AcceptOutcome::Accepted(_) => panic!("result should be rejected"),
            }
            assert!(transport.is_empty(), "rejected ID must be cleaned up");
        }
    }

    #[test]
    fn structured_failures_are_bounded_and_forwarded() {
        let mut transport = Transport::default();
        transport.submit(request("mermaid-1")).unwrap();
        transport.mark_ready();
        let outcome = transport
            .accept(
                "mermaid-1",
                RenderResult {
                    svg: None,
                    error: Some(RenderFailure {
                        code: "unsupported_external_images".into(),
                        message: "External diagram images are unsupported offline.".into(),
                    }),
                },
            )
            .unwrap();
        match outcome {
            AcceptOutcome::Accepted(event) => {
                assert!(!event.ok);
                assert!(!event.sanitized);
                assert_eq!(event.error.unwrap().code, "unsupported_external_images");
            }
            AcceptOutcome::Rejected { .. } => panic!("structured failure should be accepted"),
        }
    }

    #[test]
    fn cancellation_is_idempotent_and_stale_requests_are_pruned() {
        let mut transport = Transport::default();
        transport.submit(request("mermaid-1")).unwrap();
        assert_eq!(transport.cancel("mermaid-1"), Ok(Some(false)));
        assert_eq!(transport.cancel("mermaid-1"), Ok(None));
        assert_eq!(
            transport.cancel("has space"),
            Err(TransportError::InvalidId)
        );
        assert!(transport.is_empty());

        transport.submit(request("mermaid-active")).unwrap();
        transport.mark_ready();
        assert_eq!(transport.cancel("mermaid-active"), Ok(Some(true)));
        assert!(transport.is_empty());

        transport.submit(request("mermaid-2")).unwrap();
        transport.backdate("mermaid-2", REQUEST_TIMEOUT + Duration::from_secs(1));
        assert_eq!(transport.prune(Instant::now()), vec!["mermaid-2"]);
        assert!(transport.is_empty());
    }

    #[test]
    fn main_and_renderer_capabilities_do_not_share_application_commands() {
        let capabilities: Vec<serde_json::Value> =
            serde_json::from_str(include_str!("../capabilities/main.json")).unwrap();
        let find = |identifier: &str| {
            capabilities
                .iter()
                .find(|capability| capability["identifier"] == identifier)
                .unwrap()
        };
        let main = find("main");
        let renderer = find("mermaid-renderer");
        let permissions = |capability: &serde_json::Value| {
            capability["permissions"]
                .as_array()
                .unwrap()
                .iter()
                .map(|permission| permission.as_str().unwrap().to_string())
                .collect::<Vec<_>>()
        };
        let main_permissions = permissions(main);
        let renderer_permissions = permissions(renderer);

        let app_commands = [
            "bootstrap",
            "open_document",
            "open_folder",
            "browse_directory",
            "path_is_directory",
            "set_task_checked",
            "new_document",
            "save_document",
            "render_markdown",
            "set_window_zoom",
            "document_changed",
            "set_title",
            "close_window",
            "open_link",
            "resolve_document_link",
            "pick_open_target",
            "mermaid_render_request",
            "mermaid_render_cancel",
            "mermaid_renderer_ready",
            "mermaid_render_result",
        ];
        for command in app_commands {
            let permission = format!("allow-{}", command.replace('_', "-"));
            assert!(
                main_permissions.contains(&permission)
                    || matches!(command, "mermaid_renderer_ready" | "mermaid_render_result"),
                "main is missing {permission}"
            );
        }
        for command in [
            "allow-open-document",
            "allow-save-document",
            "allow-pick-open-target",
            "allow-mermaid-render-request",
            "allow-mermaid-render-cancel",
        ] {
            assert!(
                !renderer_permissions.contains(&command.to_string()),
                "renderer must not inherit {command}"
            );
        }
        assert!(renderer_permissions.contains(&"allow-mermaid-render-result".to_string()));
        assert!(renderer_permissions.contains(&"allow-mermaid-renderer-ready".to_string()));
        assert!(!renderer_permissions.contains(&"core:default".to_string()));
    }

    #[test]
    fn renderer_csp_blocks_every_external_resource_class() {
        for directive in [
            "default-src 'none'",
            "img-src 'none'",
            "font-src 'none'",
            "object-src 'none'",
            "frame-src 'none'",
            "worker-src 'none'",
            "connect-src ipc: http://ipc.localhost",
        ] {
            assert!(RENDERER_CSP.contains(directive), "{directive}");
        }
        assert!(!RENDERER_CSP.contains("https:"));
        assert!(!RENDERER_CSP.contains("img-src 'self'"));
    }

    #[test]
    fn renderer_html_response_replaces_the_global_csp() {
        let request = Request::builder()
            .uri("tauri://localhost/mermaid-renderer.html")
            .body(Vec::new())
            .unwrap();
        let mut response = Response::builder()
            .header(
                CONTENT_SECURITY_POLICY,
                "default-src 'self'; img-src https:",
            )
            .body(Cow::Borrowed(&b""[..]))
            .unwrap();
        apply_renderer_csp(request, &mut response);
        assert_eq!(
            response.headers().get(CONTENT_SECURITY_POLICY).unwrap(),
            RENDERER_CSP
        );
    }
}
