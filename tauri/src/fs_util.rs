// Shared file-store primitives used by both apps' #[tauri::command] wrappers.
//
// Conventions enforced here:
//   * JSON sidecar files (.manifest.json & friends) are written atomically
//     (`.tmp` + rename) so a crash can never truncate them.
//   * Binary payloads from the webview travel as the raw IPC body — never
//     base64 — with metadata in headers (header values are ASCII-only, so
//     filenames are percent-encoded).

use std::path::{Path, PathBuf};
use tauri::ipc::{InvokeBody, Request};

#[derive(serde::Serialize, Clone)]
pub struct FileEntry {
    pub filename: String,
    pub size: u64,
    pub mtime_ms: u64,
}

/// Writes via `<file>.tmp` + rename so a crash mid-write can never truncate
/// an existing file (rename is atomic within a directory).
pub fn write_file_atomic(path: &Path, contents: &[u8]) -> Result<(), String> {
    let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    let tmp = path.with_file_name(format!("{file_name}.tmp"));
    std::fs::write(&tmp, contents).map_err(|e| format!("Failed to write {tmp:?}: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("Failed to rename {tmp:?} to {path:?}: {e}"))
}

/// Basename-only filenames: rejects traversal, absolute paths and dotfiles.
pub fn sanitize_filename(filename: &str) -> Result<String, String> {
    let name = Path::new(filename)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    if name.is_empty() || name.starts_with('.') || name.contains('/') || name.contains('\\') {
        return Err(format!("Invalid filename: {filename:?}"));
    }
    Ok(name)
}

pub fn file_mtime_ms(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Reads `dir/<filename>`, returning `default_if_missing` when absent.
pub fn read_json_file(dir: &Path, filename: &str, default_if_missing: &str) -> Result<String, String> {
    let path = dir.join(filename);
    if path.exists() {
        std::fs::read_to_string(&path).map_err(|e| e.to_string())
    } else {
        Ok(default_if_missing.to_string())
    }
}

/// Atomically writes `dir/<filename>` with `content`.
pub fn write_json_atomic(dir: &Path, filename: &str, content: &str) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("Failed to create {dir:?}: {e}"))?;
    write_file_atomic(&dir.join(filename), content.as_bytes())
}

/// Deletes `dir/<filename>`; returns false when it did not exist.
pub fn delete_file_in(dir: &Path, filename: &str) -> Result<bool, String> {
    let name = sanitize_filename(filename)?;
    let path = dir.join(&name);
    if !path.exists() {
        return Ok(false);
    }
    std::fs::remove_file(&path).map_err(|e| format!("Failed to delete {path:?}: {e}"))?;
    Ok(true)
}

/// Lists regular files in `dir` (dotfiles always skipped), sorted by name.
/// `keep` filters by filename, e.g. library document extensions.
pub fn list_files(dir: &Path, keep: impl Fn(&str) -> bool) -> Vec<FileEntry> {
    let mut files = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            if !entry.path().is_file() {
                continue;
            }
            let filename = entry.file_name().to_string_lossy().to_string();
            if filename.starts_with('.') || !keep(&filename) {
                continue;
            }
            if let Ok(meta) = entry.metadata() {
                files.push(FileEntry {
                    size: meta.len(),
                    mtime_ms: file_mtime_ms(&meta),
                    filename,
                });
            }
        }
    }
    files.sort_by(|a, b| a.filename.cmp(&b.filename));
    files
}

/// Percent-decoded value of a request header ("" when absent).
pub fn request_header(request: &Request<'_>, name: &str) -> String {
    let raw = request
        .headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    percent_encoding::percent_decode_str(raw)
        .decode_utf8_lossy()
        .to_string()
}

/// The raw IPC body of a request, for commands whose bytes are the payload.
pub fn request_body_bytes<'a>(request: &'a Request<'a>) -> Result<&'a Vec<u8>, String> {
    match request.body() {
        InvokeBody::Raw(bytes) => Ok(bytes),
        _ => Err("expected the file bytes as the raw request body".to_string()),
    }
}

/// Saves a document whose bytes are the request's raw body and whose filename
/// is the (percent-encoded) `filename` header, into `dir`, atomically.
pub fn save_doc_raw(request: &Request<'_>, dir: &Path) -> Result<FileEntry, String> {
    let name = sanitize_filename(&request_header(request, "filename"))?;
    let bytes = request_body_bytes(request)?;
    std::fs::create_dir_all(dir).map_err(|e| format!("Failed to create {dir:?}: {e}"))?;
    let path = dir.join(&name);
    write_file_atomic(&path, bytes)?;
    Ok(FileEntry {
        size: bytes.len() as u64,
        mtime_ms: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
        filename: name,
    })
}

/// Reads `dir/<filename>` as raw bytes (for returning via `tauri::ipc::Response`).
pub fn read_doc_bytes(dir: &Path, filename: &str) -> Result<Vec<u8>, String> {
    let name = sanitize_filename(filename)?;
    let path: PathBuf = dir.join(&name);
    if !path.exists() {
        return Err(format!("File not found: {name}"));
    }
    std::fs::read(&path).map_err(|e| format!("Failed to read {path:?}: {e}"))
}

/// True when the filename has a library document extension.
pub fn is_library_document(filename: &str) -> bool {
    let lower = filename.to_lowercase();
    lower.ends_with(".pdf") || lower.ends_with(".epub") || lower.ends_with(".mobi")
}
