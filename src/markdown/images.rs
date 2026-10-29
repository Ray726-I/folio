use super::{
    author_html::tokenize_fragment, limits::RenderLimits, remote_image_url, PreviewLimitError,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use html5ever::tokenizer::{TagKind, Token};
use std::{
    collections::HashMap,
    fs::File,
    io::Read,
    path::{Path, PathBuf},
};

/// Per-render local-image cache keyed by canonical path. Budget accounting is
/// done over the final sanitized HTML so Markdown images and author HTML images
/// share the same occurrence/byte rules without double-counting cache hits.
pub(crate) struct ImageCache {
    cache: HashMap<PathBuf, Option<String>>,
}

impl ImageCache {
    pub(crate) fn new() -> Self {
        Self {
            cache: HashMap::new(),
        }
    }

    pub(crate) fn resolve(
        &mut self,
        destination: &str,
        base: Option<&Path>,
        allow_remote_images: bool,
        limits: &RenderLimits,
    ) -> String {
        if remote_image_url(destination) {
            return if allow_remote_images {
                destination.into()
            } else {
                super::BLOCKED_REMOTE_IMAGE.into()
            };
        }
        let Some((path, mime)) = resolve_local_path(destination, base) else {
            return super::LOCAL_IMAGE_PLACEHOLDER.into();
        };

        let encoded = match self.cache.get(&path) {
            Some(Some(encoded)) => encoded.clone(),
            Some(None) => return super::LOCAL_IMAGE_PLACEHOLDER.into(),
            None => {
                let Some(bytes) = read_bounded(&path, limits.max_image_file_bytes) else {
                    self.cache.insert(path, None);
                    return super::LOCAL_IMAGE_PLACEHOLDER.into();
                };
                let encoded = STANDARD.encode(bytes);
                self.cache.insert(path, Some(encoded.clone()));
                encoded
            }
        };

        format!("data:{mime};base64,{encoded}")
    }
}

/// Count every sanitized `<img src>` occurrence and every data-URL output byte.
/// This runs once over the final document, so Markdown-generated images and
/// author HTML images cannot use separate budgets and cache hits are charged
/// exactly as many times as they appear.
pub(crate) fn account_images(html: &str, limits: &RenderLimits) -> Result<(), PreviewLimitError> {
    if !html.contains("<img") {
        return Ok(());
    }
    let mut occurrences = 0usize;
    let mut encoded_bytes = 0usize;
    let mut error = None;
    tokenize_fragment(html, |token| {
        if error.is_some() {
            return;
        }
        let Token::TagToken(tag) = token else {
            return;
        };
        let tag_name: &str = tag.name.as_ref();
        if tag.kind == TagKind::EndTag || !tag_name.eq_ignore_ascii_case("img") {
            return;
        }
        let Some(source) = tag.attrs.iter().find(|attribute| {
            let name: &str = attribute.name.local.as_ref();
            name.eq_ignore_ascii_case("src")
        }) else {
            return;
        };
        occurrences += 1;
        if occurrences > limits.max_image_occurrences {
            error = Some(PreviewLimitError::new(
                super::PreviewLimitKind::ImageOccurrences,
                format!(
                    "This document contains more than the {} image occurrences allowed in a preview.",
                    limits.max_image_occurrences
                ),
            ));
            return;
        }
        let source_url: &str = source.value.as_ref();
        if super::is_data_url(source_url) {
            encoded_bytes = encoded_bytes.saturating_add(source_url.len());
            if encoded_bytes > limits.max_encoded_image_bytes {
                error = Some(PreviewLimitError::new(
                    super::PreviewLimitKind::ImageBytes,
                    format!(
                        "This document's embedded images need more than the {} MiB preview limit.",
                        limits.max_encoded_image_bytes / super::limits::MIB
                    ),
                ));
            }
        }
    });
    error.map_or(Ok(()), Err)
}

/// Resolve a Markdown image destination to a canonical local path inside the
/// document directory and its media type. Returns `None` for absolute paths,
/// URL-like values, escapes, or unsupported extensions.
pub(crate) fn resolve_local_path(
    destination: &str,
    base: Option<&Path>,
) -> Option<(PathBuf, &'static str)> {
    if destination.contains(':') || destination.starts_with('/') {
        return None;
    }
    let base = base?;
    let decoded = percent_encoding::percent_decode_str(destination)
        .decode_utf8()
        .ok()?;
    let path = base.join(decoded.as_ref()).canonicalize().ok()?;
    if !path.starts_with(base) {
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
    Some((path, mime))
}

/// Read at most `limit` bytes. The file is opened and read with a hard bound;
/// metadata length is advisory only, so a file that grows after a metadata
/// check still cannot exceed the per-image budget.
pub(crate) fn read_bounded(path: &Path, limit: usize) -> Option<Vec<u8>> {
    let file = File::open(path).ok()?;
    let metadata = file.metadata().ok()?;
    if !metadata.is_file() {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len() > limit {
        return None;
    }
    Some(bytes)
}

/// Compatibility helper used by the focused image-security test.
#[allow(dead_code)]
pub(crate) fn local_image(
    destination: &str,
    base: Option<&Path>,
    allow_remote_images: bool,
) -> Option<String> {
    if remote_image_url(destination) {
        return Some(if allow_remote_images {
            destination.into()
        } else {
            super::BLOCKED_REMOTE_IMAGE.into()
        });
    }
    let base = base?.canonicalize().ok()?;
    let (path, mime) = resolve_local_path(destination, Some(&base))?;
    let bytes = read_bounded(&path, 10 * 1024 * 1024)?;
    Some(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}
