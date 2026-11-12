use comrak::nodes::LineColumn;
use std::fmt;

pub(crate) const MIB: usize = 1024 * 1024;

/// Central preview budgets. The document loader independently enforces the
/// same 20 MiB source limit, but rendering is also callable from tests and the
/// editor fixture, so it validates its own input.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RenderLimits {
    pub max_source_bytes: usize,
    pub max_lines: usize,
    pub max_blockquote_depth: usize,
    pub max_ast_nodes: usize,
    pub max_html_bytes: usize,
    pub max_image_occurrences: usize,
    pub max_encoded_image_bytes: usize,
    pub max_image_file_bytes: usize,
}

pub const DEFAULT_RENDER_LIMITS: RenderLimits = RenderLimits {
    max_source_bytes: 20 * MIB,
    max_lines: 200_000,
    max_blockquote_depth: 128,
    max_ast_nodes: 200_000,
    max_html_bytes: 64 * MIB,
    max_image_occurrences: 200,
    max_encoded_image_bytes: 32 * MIB,
    max_image_file_bytes: 10 * MIB,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PreviewLimitKind {
    SourceBytes,
    Lines,
    BlockquoteDepth,
    AstNodes,
    HtmlBytes,
    ImageOccurrences,
    ImageBytes,
    MathComplexity,
}

impl PreviewLimitKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SourceBytes => "source_bytes",
            Self::Lines => "lines",
            Self::BlockquoteDepth => "blockquote_depth",
            Self::AstNodes => "ast_nodes",
            Self::HtmlBytes => "html_bytes",
            Self::ImageOccurrences => "image_occurrences",
            Self::ImageBytes => "image_bytes",
            Self::MathComplexity => "math_complexity",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct PreviewLimitError {
    pub kind: PreviewLimitKind,
    pub message: String,
}

impl PreviewLimitError {
    pub(crate) fn new(kind: PreviewLimitKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

impl fmt::Display for PreviewLimitError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for PreviewLimitError {}

/// Cheap structural checks, performed before Comrak is allowed to parse.
///
/// The progress scan and depth counting are both linear in the source length.
/// Limit checks happen before parsing so adversarial nesting cannot spend
/// parser/exponential work first.
pub(crate) fn preflight(source: &str, limits: &RenderLimits) -> Result<(), PreviewLimitError> {
    if source.len() > limits.max_source_bytes {
        return Err(PreviewLimitError::new(
            PreviewLimitKind::SourceBytes,
            format!(
                "This document is larger than the {} MB preview limit.",
                limits.max_source_bytes / MIB
            ),
        ));
    }

    let mut line_count = 0usize;
    let mut maximum_depth = 0usize;
    let mut fence: Option<Fence> = None;
    let mut list_indents: Vec<(usize, usize)> = Vec::new();
    if !source.is_empty() {
        line_count = 1;
        let mut line_start = 0usize;
        for (index, byte) in source.bytes().enumerate() {
            if byte == b'\n' {
                scan_structural_line(
                    &source[line_start..index],
                    &mut fence,
                    &mut list_indents,
                    &mut maximum_depth,
                );
                line_start = index + 1;
                if line_start < source.len() {
                    line_count += 1;
                }
            }
        }
        if line_start < source.len() {
            scan_structural_line(
                &source[line_start..],
                &mut fence,
                &mut list_indents,
                &mut maximum_depth,
            );
        }
    }

    if line_count > limits.max_lines {
        return Err(PreviewLimitError::new(
            PreviewLimitKind::Lines,
            format!(
                "This document has more than the {} preview lines allowed.",
                limits.max_lines
            ),
        ));
    }
    if maximum_depth > limits.max_blockquote_depth {
        return Err(PreviewLimitError::new(
            PreviewLimitKind::BlockquoteDepth,
            format!(
                "This document nests blockquotes {} deep; the preview limit is {}.",
                maximum_depth, limits.max_blockquote_depth
            ),
        ));
    }
    if math_scan_exceeds(source) {
        return Err(PreviewLimitError::new(
            PreviewLimitKind::MathComplexity,
            "This document's math delimiters exceed the preview scanning budget. Simplify the math or split the document into smaller previews.",
        ));
    }
    Ok(())
}

/// Upper bound on raw byte distance and delimiter-candidate visits for
/// Comrak 0.56's LaTeX and code-math scanners. Both scanners repeatedly walk
/// the remaining input for every opener, so many unmatched openers are
/// quadratic even when each individual scan is short.
const MAX_MATH_SCAN_BYTES: usize = 256 * MIB;
const MAX_MATH_SCAN_CANDIDATES: usize = 2_000_000;

/// Estimate Comrak's math matching work in one reverse pass. For each opener
/// we charge both the byte distance to the next matching closer (or EOF) and
/// the delimiter candidates scanned (backslashes for LaTeX, dollars for code
/// math). The candidate count catches compact adversarial runs that a
/// byte-only budget underestimates. This is deliberately conservative:
/// openers inside literal code/HTML and nested openers Comrak would skip also
/// count, so some valid or code-only documents near the budgets can be
/// rejected.
fn math_scan_exceeds(source: &str) -> bool {
    if !source.contains("\\(") && !source.contains("\\[") && !source.contains("$`") {
        return false;
    }
    let bytes = source.as_bytes();
    let mut next_parenthesis = None;
    let mut next_bracket = None;
    let mut next_code_dollar = None;
    let mut parenthesis_candidates = None;
    let mut bracket_candidates = None;
    let mut code_candidates = None;
    let mut backslashes_right = 0usize;
    let mut dollars_right = 0usize;
    let mut byte_work = 0usize;
    let mut candidate_work = 0usize;
    for index in (0..bytes.len()).rev() {
        // Check openers before closers so a code-math `$` that is both a
        // closing and an opening delimiter does not treat itself as its own
        // closer.
        if index + 1 < bytes.len() && bytes[index] == b'\\' {
            let (closer, candidates) = match bytes[index + 1] {
                b'(' => (next_parenthesis, parenthesis_candidates),
                b'[' => (next_bracket, bracket_candidates),
                _ => (None, None),
            };
            if bytes[index + 1] == b'(' || bytes[index + 1] == b'[' {
                let distance = closer.map_or(bytes.len() - index, |close| close - index);
                byte_work = byte_work.saturating_add(distance);
                let candidate = candidates.map_or(backslashes_right, |count| {
                    backslashes_right.saturating_sub(count)
                });
                candidate_work = candidate_work.saturating_add(candidate);
            }
        }
        if index + 1 < bytes.len() && bytes[index] == b'$' && bytes[index + 1] == b'`' {
            let distance = next_code_dollar.map_or(bytes.len() - index, |close| close - index);
            byte_work = byte_work.saturating_add(distance);
            let candidate =
                code_candidates.map_or(dollars_right, |count| dollars_right.saturating_sub(count));
            candidate_work = candidate_work.saturating_add(candidate);
        }
        if byte_work > MAX_MATH_SCAN_BYTES || candidate_work > MAX_MATH_SCAN_CANDIDATES {
            return true;
        }

        // This position can close an opener further left.
        if index > 0 {
            match (bytes[index], bytes[index - 1]) {
                (b')', b'\\') => {
                    next_parenthesis = Some(index - 1);
                    parenthesis_candidates = Some(backslashes_right);
                }
                (b']', b'\\') => {
                    next_bracket = Some(index - 1);
                    bracket_candidates = Some(backslashes_right);
                }
                (b'$', b'`') => {
                    next_code_dollar = Some(index);
                    code_candidates = Some(dollars_right);
                }
                _ => {}
            }
        }
        if bytes[index] == b'\\' {
            backslashes_right += 1;
        }
        if bytes[index] == b'$' {
            dollars_right += 1;
        }
    }
    false
}

#[derive(Clone, Copy)]
struct Fence {
    character: u8,
    length: usize,
    quote_depth: usize,
    list_indent: Option<usize>,
}

#[derive(Clone, Copy)]
struct ListMarker {
    content_indent: usize,
    spaces_after: usize,
}

struct ParsedLine<'a> {
    quote_depth: usize,
    leading_indent: usize,
    indent: usize,
    content: &'a str,
    list: Option<ListMarker>,
}

/// Track fenced code before counting blockquote depth. Fence content is
/// literal text, but a fence opened inside a blockquote or list is contained by
/// that container: a nonblank line that leaves the opener's quote depth or list
/// content indentation ends the fence and is scanned normally. Only a fence
/// opened at the document root may run to EOF without a closing fence.
///
/// This is a narrow container scanner, not a CommonMark parser. When a line's
/// container context is ambiguous it ends the fence early, which can only make
/// the depth check more conservative.
fn scan_structural_line(
    line: &str,
    fence: &mut Option<Fence>,
    list_indents: &mut Vec<(usize, usize)>,
    maximum_depth: &mut usize,
) {
    if line.trim().is_empty() {
        return;
    }
    let parsed = parse_line(line);
    if let Some(opening) = *fence {
        let line_indent = container_indent(&parsed, opening.quote_depth);
        let stays_in_container = parsed.quote_depth >= opening.quote_depth
            && opening
                .list_indent
                .is_none_or(|indent| line_indent >= indent);
        if stays_in_container {
            let close_ceiling = opening
                .list_indent
                .map_or(3, |indent| indent.saturating_add(3));
            if parsed.quote_depth == opening.quote_depth
                && line_indent <= close_ceiling
                && parsed.list.is_none()
                && is_fence_close(parsed.content, opening.character, opening.length)
            {
                *fence = None;
            }
            return;
        }
        *fence = None;
    }

    update_list_context(&parsed, list_indents);
    let depth = blockquote_depth(line);
    *maximum_depth = (*maximum_depth).max(depth);
    if let Some(opening) = fence_open_for(&parsed, list_indents) {
        *fence = Some(opening);
    }
}

fn container_indent(parsed: &ParsedLine<'_>, opening_quote_depth: usize) -> usize {
    if opening_quote_depth == 0 {
        parsed.leading_indent
    } else {
        parsed.indent
    }
}

fn update_list_context(parsed: &ParsedLine<'_>, list_indents: &mut Vec<(usize, usize)>) {
    while let Some(&(quote_depth, content_indent)) = list_indents.last() {
        if parsed.quote_depth < quote_depth
            || (parsed.quote_depth == quote_depth && parsed.indent < content_indent)
        {
            list_indents.pop();
        } else {
            break;
        }
    }
    if let Some(marker) = parsed.list {
        list_indents.push((parsed.quote_depth, marker.content_indent));
    }
}

fn fence_open_for(parsed: &ParsedLine<'_>, list_indents: &[(usize, usize)]) -> Option<Fence> {
    if let Some(marker) = parsed.list {
        if marker.spaces_after > 4 {
            return None;
        }
    }
    let active_list_indent = if let Some(marker) = parsed.list {
        Some(marker.content_indent)
    } else {
        list_indents
            .last()
            .filter(|(quote_depth, content_indent)| {
                *quote_depth == parsed.quote_depth && parsed.indent >= *content_indent
            })
            .map(|(_, content_indent)| *content_indent)
    };
    let ceiling = active_list_indent.map_or(3, |indent| indent.saturating_add(3));
    if parsed.indent > ceiling {
        return None;
    }
    let (character, length) = fence_open(parsed.content)?;
    Some(Fence {
        character,
        length,
        quote_depth: parsed.quote_depth,
        list_indent: active_list_indent,
    })
}

/// Parse the narrow container prefix needed by the fence scanner: quote depth,
/// list content indentation, and the remainder after those containers.
fn parse_line(line: &str) -> ParsedLine<'_> {
    let bytes = line.as_bytes();
    let mut index = 0usize;
    let mut quote_depth = 0usize;
    let mut leading_indent = None;
    loop {
        let before_spaces = index;
        let mut spaces = 0;
        while index < bytes.len() && matches!(bytes[index], b' ' | b'\t') && spaces < 3 {
            spaces += column_width(bytes[index]);
            index += 1;
        }
        if index < bytes.len() && bytes[index] == b'>' {
            if leading_indent.is_none() {
                leading_indent = Some(spaces);
            }
            quote_depth += 1;
            index += 1;
            continue;
        }
        index = before_spaces;
        break;
    }

    let mut indent = 0usize;
    while index < bytes.len() && matches!(bytes[index], b' ' | b'\t') {
        indent += column_width(bytes[index]);
        index += 1;
    }
    let leading_indent = leading_indent.unwrap_or(indent);
    let marker_indent = indent;
    let mut list = None;
    if let Some(marker_width) = list_marker_width(bytes, index) {
        index += marker_width;
        let mut spaces_after = 0usize;
        while index < bytes.len() && matches!(bytes[index], b' ' | b'\t') {
            spaces_after += column_width(bytes[index]);
            index += 1;
        }
        let separator = if spaces_after > 4 { 1 } else { spaces_after };
        list = Some(ListMarker {
            content_indent: marker_indent + marker_width + separator,
            spaces_after,
        });
    }

    ParsedLine {
        quote_depth,
        leading_indent,
        indent,
        content: &line[index..],
        list,
    }
}

fn column_width(byte: u8) -> usize {
    if byte == b'\t' {
        4
    } else {
        1
    }
}

fn list_marker_width(bytes: &[u8], index: usize) -> Option<usize> {
    if index < bytes.len()
        && matches!(bytes[index], b'-' | b'+' | b'*')
        && bytes
            .get(index + 1)
            .is_some_and(|byte| matches!(byte, b' ' | b'\t'))
    {
        return Some(1);
    }
    let mut end = index;
    while end < bytes.len() && bytes[end].is_ascii_digit() {
        end += 1;
    }
    if end > index
        && bytes
            .get(end)
            .is_some_and(|byte| matches!(byte, b'.' | b')'))
        && bytes
            .get(end + 1)
            .is_some_and(|byte| matches!(byte, b' ' | b'\t'))
    {
        return Some(end - index + 1);
    }
    None
}

fn blockquote_depth(line: &str) -> usize {
    container_prefix(line, usize::MAX).0
}

/// Remove structural container markers and return the quote depth plus the
/// remaining fragment. `max_spaces` controls how much indentation is treated
/// as fence indentation (3) versus conservative blockquote indentation
/// (unbounded, so list-indented quotes cannot hide depth).
fn container_prefix(line: &str, max_spaces: usize) -> (usize, &str) {
    let bytes = line.as_bytes();
    let mut index = 0usize;
    let mut depth = 0usize;
    loop {
        let mut spaces = 0;
        while index < bytes.len()
            && matches!(bytes[index], b' ' | b'\t')
            && (max_spaces == usize::MAX || spaces < max_spaces)
        {
            index += 1;
            spaces += 1;
        }
        if index < bytes.len() && bytes[index] == b'>' {
            depth += 1;
            index += 1;
            continue;
        }
        if index < bytes.len()
            && matches!(bytes[index], b'-' | b'+' | b'*')
            && index + 1 < bytes.len()
            && matches!(bytes[index + 1], b' ' | b'\t')
        {
            index += 1;
            continue;
        }
        if index < bytes.len() && bytes[index].is_ascii_digit() {
            let digit_start = index;
            while index < bytes.len() && bytes[index].is_ascii_digit() {
                index += 1;
            }
            if index + 1 < bytes.len()
                && matches!(bytes[index], b'.' | b')')
                && matches!(bytes[index + 1], b' ' | b'\t')
            {
                index += 1;
                continue;
            }
            index = digit_start;
        }
        break;
    }
    (depth, &line[index..])
}

fn fence_open(remainder: &str) -> Option<(u8, usize)> {
    let bytes = remainder.as_bytes();
    let character = *bytes.first()?;
    if !matches!(character, b'`' | b'~') {
        return None;
    }
    let length = bytes.iter().take_while(|byte| **byte == character).count();
    (length >= 3).then_some((character, length))
}

fn is_fence_close(remainder: &str, character: u8, opening_length: usize) -> bool {
    let bytes = remainder.as_bytes();
    let length = bytes.iter().take_while(|byte| **byte == character).count();
    length >= opening_length
        && bytes[length..]
            .iter()
            .all(|byte| matches!(byte, b' ' | b'\t'))
}

/// One line-start index per parse. Source positions are 1-based and, with
/// Comrak's default options, columns are UTF-8 byte offsets. Lookups therefore
/// add the column directly and validate the resulting char boundary instead of
/// rescanning every preceding line per node.
pub(crate) struct LineIndex {
    starts: Vec<usize>,
}

impl LineIndex {
    pub(crate) fn new(source: &str) -> Self {
        let mut starts = Vec::with_capacity(64);
        starts.push(0);
        for (index, byte) in source.bytes().enumerate() {
            if byte == b'\n' {
                starts.push(index + 1);
            }
        }
        Self { starts }
    }

    pub(crate) fn offset(&self, source: &str, position: LineColumn) -> Option<usize> {
        let offset = self.raw_offset(position)?;
        if offset > source.len() || !source.is_char_boundary(offset) {
            return None;
        }
        Some(offset)
    }

    /// Comrak end positions point at the final byte of the final character, so
    /// the exclusive slice end is one byte later and that is the boundary to
    /// validate (for example, the last byte of `😀` is not itself a boundary).
    pub(crate) fn end_offset(&self, source: &str, position: LineColumn) -> Option<usize> {
        let end = self.raw_offset(position)?.checked_add(1)?;
        if end > source.len() || !source.is_char_boundary(end) {
            return None;
        }
        Some(end)
    }

    fn raw_offset(&self, position: LineColumn) -> Option<usize> {
        let start = *self.starts.get(position.line.checked_sub(1)?)?;
        start.checked_add(position.column.checked_sub(1)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_index_handles_empty_unicode_and_out_of_range_positions() {
        let source = "a\nβ\n\nlast";
        let index = LineIndex::new(source);
        assert_eq!(
            index.offset(source, LineColumn { line: 1, column: 1 }),
            Some(0)
        );
        assert_eq!(
            index.offset(source, LineColumn { line: 2, column: 1 }),
            Some(2)
        );
        assert_eq!(
            index.offset(source, LineColumn { line: 2, column: 2 }),
            None,
            "the second byte of a multibyte character is not a char boundary"
        );
        assert_eq!(
            index.offset(source, LineColumn { line: 4, column: 1 }),
            Some(6)
        );
        assert_eq!(
            index.offset(source, LineColumn { line: 5, column: 1 }),
            None
        );
        assert_eq!(
            index.offset(source, LineColumn { line: 0, column: 1 }),
            None
        );
        assert!(LineIndex::new("").offset("", LineColumn { line: 1, column: 1 }) == Some(0));
    }

    #[test]
    fn blockquote_preflight_counts_list_combinations_conservatively() {
        assert_eq!(blockquote_depth("> > > nested"), 3);
        assert_eq!(blockquote_depth("- > > nested"), 2);
        assert_eq!(blockquote_depth("1. > nested"), 1);
        assert_eq!(blockquote_depth("    > list-indented quote"), 1);
        assert_eq!(blockquote_depth("\t> tab-indented quote"), 1);
        assert_eq!(blockquote_depth("text > not a marker"), 0);
    }

    #[test]
    fn default_budgets_match_the_approved_values() {
        assert_eq!(DEFAULT_RENDER_LIMITS.max_source_bytes, 20 * MIB);
        assert_eq!(DEFAULT_RENDER_LIMITS.max_lines, 200_000);
        assert_eq!(DEFAULT_RENDER_LIMITS.max_blockquote_depth, 128);
        assert_eq!(DEFAULT_RENDER_LIMITS.max_ast_nodes, 200_000);
        assert_eq!(DEFAULT_RENDER_LIMITS.max_html_bytes, 64 * MIB);
        assert_eq!(DEFAULT_RENDER_LIMITS.max_image_occurrences, 200);
        assert_eq!(DEFAULT_RENDER_LIMITS.max_encoded_image_bytes, 32 * MIB);
        assert_eq!(DEFAULT_RENDER_LIMITS.max_image_file_bytes, 10 * MIB);
    }

    #[test]
    fn preflight_enforces_line_depth_and_source_limits() {
        let limits = RenderLimits {
            max_source_bytes: 8,
            max_lines: 2,
            max_blockquote_depth: 2,
            ..DEFAULT_RENDER_LIMITS
        };
        assert_eq!(
            preflight("too long!", &limits).unwrap_err().kind,
            PreviewLimitKind::SourceBytes
        );
        assert_eq!(
            preflight(
                "a\nb\nc",
                &RenderLimits {
                    max_source_bytes: 100,
                    ..limits
                }
            )
            .unwrap_err()
            .kind,
            PreviewLimitKind::Lines
        );
        assert_eq!(
            preflight(
                "> > > deep",
                &RenderLimits {
                    max_source_bytes: 100,
                    ..limits
                }
            )
            .unwrap_err()
            .kind,
            PreviewLimitKind::BlockquoteDepth
        );
        assert!(preflight(
            "a\nb",
            &RenderLimits {
                max_source_bytes: 100,
                ..limits
            }
        )
        .is_ok());
    }

    #[test]
    fn math_budget_allows_a_few_long_scans_through_plain_text() {
        let mut source = String::new();
        for _ in 0..4 {
            source.push_str("\\(missing\n\n");
        }
        source.push_str(&"x".repeat(17 * MIB));
        assert!(
            preflight(&source, &DEFAULT_RENDER_LIMITS).is_ok(),
            "a few unmatched openers followed by plain text must stay previewable"
        );
    }
}
