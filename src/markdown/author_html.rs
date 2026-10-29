use html5ever::{
    tendril::{ByteTendril, StrTendril},
    tokenizer::{BufferQueue, Tag, TagKind, Token, TokenSink, TokenSinkResult, Tokenizer},
};
use std::cell::RefCell;

use comrak::nodes::{AstNode, NodeValue};

/// Attributes that the renderer generates or the editor attaches client-side.
/// Author HTML must never be allowed to supply them: a forged `data-sourcepos`
/// could otherwise inherit a neighbouring generated block's edit index, and a
/// forged task index could toggle a different source location.
const EDITING_ATTRIBUTES: [&str; 3] = ["data-sourcepos", "data-task-index", "data-edit-index"];

/// Normalize every author HTML literal with the HTML tokenizer. Tokenization
/// preserves the literal's start/end fragment boundaries: it never builds a
/// tree, so an opening `<kbd>` or `<details>` is not auto-closed just because
/// the matching end tag arrives in another fragment.
pub(crate) fn strip_author_markers<'a>(root: &'a AstNode<'a>) {
    for node in root.descendants() {
        let mut data = node.data_mut();
        let literal = match &mut data.value {
            NodeValue::HtmlBlock(block) => &mut block.literal,
            NodeValue::HtmlInline(html) => html,
            _ => continue,
        };
        *literal = normalize_literal(literal);
    }
}

pub(crate) fn normalize_literal(literal: &str) -> String {
    let mut output = String::with_capacity(literal.len());
    tokenize_fragment(literal, |token| write_token(token, &mut output));
    output
}

/// Run the HTML tokenizer over a fragment and hand every token to `callback`.
/// This is a tokenizer, not a tree builder: no implied start/end tags are
/// inserted, which is what lets author HTML keep its fragment boundaries.
pub(crate) fn tokenize_fragment(html: &str, callback: impl FnMut(Token)) {
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

fn write_token(token: Token, output: &mut String) {
    match token {
        Token::TagToken(tag) => write_tag(tag, output),
        Token::CharacterTokens(text) => escape_text(&text, output),
        Token::NullCharacterToken => output.push('\u{fffd}'),
        Token::CommentToken(_)
        | Token::DoctypeToken(_)
        | Token::ParseError(_)
        | Token::EOFToken => {}
    }
}

fn write_tag(tag: Tag, output: &mut String) {
    let tag_name: &str = tag.name.as_ref();
    if tag.kind == TagKind::EndTag {
        output.push_str("</");
        output.push_str(tag_name);
        output.push('>');
        return;
    }

    let is_input = tag_name.eq_ignore_ascii_case("input");
    if is_input && !is_checkbox_input(&tag) {
        return;
    }

    output.push('<');
    output.push_str(tag_name);
    let mut seen: Vec<&str> = Vec::new();
    for attribute in &tag.attrs {
        let name: &str = attribute.name.local.as_ref();
        if is_editing_attribute(name)
            || seen
                .iter()
                .any(|previous| previous.eq_ignore_ascii_case(name))
        {
            continue;
        }
        seen.push(name);
        output.push(' ');
        output.push_str(name);
        output.push_str("=\"");
        if is_input && name.eq_ignore_ascii_case("type") {
            output.push_str("checkbox");
        } else {
            escape_attribute(&attribute.value, output);
        }
        output.push('"');
    }
    if tag.self_closing {
        output.push('/');
    }
    output.push('>');
}

fn is_editing_attribute(name: &str) -> bool {
    EDITING_ATTRIBUTES
        .iter()
        .any(|attribute| attribute.eq_ignore_ascii_case(name))
}

/// The actual parsed `type` attribute decides checkbox-ness. Text in another
/// attribute (for example `title="type=checkbox"`) is irrelevant.
fn is_checkbox_input(tag: &Tag) -> bool {
    tag.attrs
        .iter()
        .find(|attribute| {
            let name: &str = attribute.name.local.as_ref();
            name.eq_ignore_ascii_case("type")
        })
        .is_some_and(|attribute| {
            attribute
                .value
                .trim_matches(|character: char| character.is_ascii_whitespace())
                .eq_ignore_ascii_case("checkbox")
        })
}

fn escape_text(value: &str, output: &mut String) {
    for character in value.chars() {
        match character {
            '&' => output.push_str("&amp;"),
            '<' => output.push_str("&lt;"),
            _ => output.push(character),
        }
    }
}

fn escape_attribute(value: &StrTendril, output: &mut String) {
    for character in value.chars() {
        match character {
            '&' => output.push_str("&amp;"),
            '"' => output.push_str("&quot;"),
            '\'' => output.push_str("&#39;"),
            _ => output.push(character),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fragment_boundaries_and_edit_markers_are_preserved_and_removed() {
        assert_eq!(
            normalize_literal("a <kbd>Ctrl</kbd> b"),
            "a <kbd>Ctrl</kbd> b"
        );
        assert_eq!(
            normalize_literal("<details>\n<summary>More</summary>"),
            "<details>\n<summary>More</summary>"
        );

        let case =
            "<ul>\n<li/data-sourcepos=\"1:1-1:2\"><input type=\"checkbox\" disabled></li>\n</ul>";
        let cleaned = normalize_literal(case);
        assert!(!cleaned.to_ascii_lowercase().contains("data-sourcepos"));
        assert!(cleaned.contains("<li><input type=\"checkbox\" disabled=\"\">"));
    }

    #[test]
    fn non_checkbox_inputs_are_removed_and_real_type_attributes_decide() {
        assert_eq!(
            normalize_literal(
                "<input type=\"TEXT\"><input type=checkbox><input><input title=\"type=checkbox\" type=text>"
            ),
            "<input type=\"checkbox\">"
        );
        assert_eq!(
            normalize_literal("<input title=\"type=text\" type=checkbox>"),
            "<input title=\"type=text\" type=\"checkbox\">"
        );
    }
}
