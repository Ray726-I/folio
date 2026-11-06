use super::{
    author_html::tokenize_fragment, limits::RenderLimits, remote_image_url, PreviewLimitError,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use html5ever::tokenizer::{TagKind, Token};
use std::{
    collections::{HashMap, VecDeque},
    fs::File,
    io::Read,
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex},
    time::SystemTime,
};

/// One version of a local image file: canonical path, modification time, and
/// length. Editing an image changes at least its mtime or its length, so an
/// entry is never served for a different version of the file.
type ImageKey = (PathBuf, SystemTime, u64);

/// Upper bounds for the process-wide encoded-image cache. Entries are evicted
/// oldest-first until both the count and the byte budget hold.
const MAX_IMAGE_CACHE_ENTRIES: usize = 128;
const MAX_IMAGE_CACHE_BYTES: usize = 64 * 1024 * 1024;

/// Process-wide local-image cache keyed by canonical path, mtime, and length.
/// The value is the base64 payload (not the `data:` prefix), or `None` when the
/// file is present but unreadable or over the per-file budget. Budget
/// accounting is still done over the final sanitized HTML on every render, so
/// cache hits are charged once per document occurrence.
#[derive(Default)]
pub(crate) struct ImageCache {
    cache: HashMap<ImageKey, Option<String>>,
    /// Insertion order, so the oldest entry is evicted first.
    order: VecDeque<ImageKey>,
    /// Total bytes of encoded payloads currently cached.
    bytes: usize,
}

impl ImageCache {
    fn new() -> Self {
        Self::default()
    }

    fn insert(&mut self, key: ImageKey, encoded: Option<String>) {
        let bytes = encoded.as_ref().map_or(0, String::len);
        if bytes > MAX_IMAGE_CACHE_BYTES {
            return;
        }
        if let Some(previous) = self.cache.insert(key.clone(), encoded) {
            self.bytes = self
                .bytes
                .saturating_sub(previous.map_or(0, |value| value.len()))
                + bytes;
            return;
        }
        self.bytes += bytes;
        self.order.push_back(key);
        while self.cache.len() > MAX_IMAGE_CACHE_ENTRIES || self.bytes > MAX_IMAGE_CACHE_BYTES {
            let Some(oldest) = self.order.pop_front() else {
                break;
            };
            if let Some(evicted) = self.cache.remove(&oldest) {
                self.bytes = self
                    .bytes
                    .saturating_sub(evicted.map_or(0, |value| value.len()));
            }
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
        let encoded = match file_stamp(&path) {
            Some((modified, length)) => {
                let key = (path, modified, length);
                // The per-file budget is a property of the call, not of the
                // file, so it must be applied to cached entries too and never
                // cached itself.
                if length > limits.max_image_file_bytes as u64 {
                    return super::LOCAL_IMAGE_PLACEHOLDER.into();
                }
                match self.cache.get(&key) {
                    Some(Some(encoded)) => encoded.clone(),
                    Some(None) => return super::LOCAL_IMAGE_PLACEHOLDER.into(),
                    None => {
                        let Some(bytes) = read_bounded(&key.0, limits.max_image_file_bytes) else {
                            self.insert(key, None);
                            return super::LOCAL_IMAGE_PLACEHOLDER.into();
                        };
                        let encoded = STANDARD.encode(bytes);
                        self.insert(key, Some(encoded.clone()));
                        encoded
                    }
                }
            }
            None => {
                // No stable identity to invalidate (missing file, or a
                // filesystem without a modification time): read directly.
                let Some(bytes) = read_bounded(&path, limits.max_image_file_bytes) else {
                    return super::LOCAL_IMAGE_PLACEHOLDER.into();
                };
                STANDARD.encode(bytes)
            }
        };

        format!("data:{mime};base64,{encoded}")
    }
}

static IMAGE_CACHE: LazyLock<Mutex<ImageCache>> = LazyLock::new(|| Mutex::new(ImageCache::new()));

/// Resolve a Markdown image destination through the process-wide encoded-image
/// cache. Behaviour matches the old per-render cache: remote images follow the
/// privacy preference, missing files use the placeholder, and the per-file
/// budget is enforced before encoding.
pub(crate) fn resolve_image(
    destination: &str,
    base: Option<&Path>,
    allow_remote_images: bool,
    limits: &RenderLimits,
) -> String {
    let mut cache = IMAGE_CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    cache.resolve(destination, base, allow_remote_images, limits)
}

/// Modification time and length of a canonical local image. Missing paths,
/// non-regular files, and filesystems without a usable modification time have
/// no stamp and are therefore read uncached.
fn file_stamp(path: &Path) -> Option<(SystemTime, u64)> {
    let metadata = std::fs::metadata(path).ok()?;
    if !metadata.is_file() {
        return None;
    }
    Some((metadata.modified().ok()?, metadata.len()))
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
/// document directory and its media type. Relative and absolute paths are
/// accepted only when their canonical target is within that directory.
pub(crate) fn resolve_local_path(
    destination: &str,
    base: Option<&Path>,
) -> Option<(PathBuf, &'static str)> {
    if destination.contains(':') && !Path::new(destination).is_absolute() {
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
