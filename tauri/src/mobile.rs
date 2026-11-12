//! iOS-specific layer: Documents-based data root, the `courseasset://`
//! protocol that serves synced course files to the webview, and the zip
//! bundle sync from the desktop. Compiled only for `target_os = "ios"`.
//!
//! Data layout (user-visible in the Files app via UIFileSharingEnabled):
//! `Documents/{courses,library,prompts,groups.json}` — the same shape the
//! desktop uses under its data dir, resolved through courses_fs.

use std::path::PathBuf;
use tauri::{Emitter, Manager};

/// Documents (fallback: app support) — the iOS data root.
pub fn base_dir(app: &tauri::AppHandle) -> PathBuf {
    match app.path().document_dir() {
        Ok(documents) => documents,
        Err(_) => app
            .path()
            .app_data_dir()
            .expect("app_data_dir is always available on iOS"),
    }
}

pub fn courses_root(app: &tauri::AppHandle) -> PathBuf {
    let dir = base_dir(app).join("courses");
    if !dir.exists() {
        let _ = std::fs::create_dir_all(&dir);
    }
    dir
}

fn asset_content_type(path: &std::path::Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "txt" | "md" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// Serves synced course files (`<courses>/<course_id>/assets/**`) to the
/// webview via `courseasset://localhost/...` so lesson markdown can reference
/// the device's own assets folder and display offline.
pub fn serve_course_asset(app: &tauri::AppHandle, uri: &str) -> tauri::http::Response<Vec<u8>> {
    let respond = |status: u16, content_type: &str, body: Vec<u8>| {
        tauri::http::Response::builder()
            .status(status)
            .header("Content-Type", content_type)
            .header("Cache-Control", "public, max-age=86400")
            .body(body)
            .unwrap_or_else(|_| tauri::http::Response::new(Vec::new()))
    };

    let Some((course_id, rel)) = crate::pdf::parse_course_asset_uri(uri) else {
        return respond(400, "text/plain; charset=utf-8", b"invalid courseasset URI".to_vec());
    };

    let file_path = courses_root(app).join(&course_id).join(&rel);

    match std::fs::read(&file_path) {
        Ok(bytes) => respond(200, asset_content_type(&file_path), bytes),
        Err(e) => respond(
            404,
            "text/plain; charset=utf-8",
            format!("asset not found: {rel} ({e})").into_bytes(),
        ),
    }
}

// ── Zip Sync (iPad ← desktop bundle archive) ──────────────────────────────────

/// Progress channel consumed by the webview sync UI (subtle grey log lines).
/// Quietly ignored when no listener is attached (e.g. background auto-sync).
fn emit_sync_progress(app: &tauri::AppHandle, message: String) {
    let _ = app.emit("sync-progress", serde_json::json!({ "message": message }));
}

#[derive(serde::Serialize)]
struct CourseSyncSummary {
    course_id: String,
    files: usize,
    assets: usize,
}

#[derive(serde::Serialize)]
pub struct SyncZipSummary {
    #[serde(rename = "generatedAt")]
    generated_at: String,
    courses: Vec<CourseSyncSummary>,
    #[serde(rename = "llmConfig")]
    llm_config: Option<serde_json::Value>,
}

/// Last-writer-wins merge of markup stroke arrays keyed by id (ISO date
/// strings compare lexicographically) so a fresh sync never drops iPad-local
/// annotations that haven't been pushed yet. Tombstones survive because the
/// newer entry always wins, deleted or not.
fn merge_annotations_lww(existing_path: &std::path::Path, incoming: &str) -> String {
    let parse = |s: &str| -> Vec<serde_json::Value> { serde_json::from_str(s).unwrap_or_default() };
    let local = std::fs::read_to_string(existing_path).unwrap_or_default();
    let date_of =
        |v: &serde_json::Value| -> String { v.get("date").and_then(|d| d.as_str()).unwrap_or_default().to_string() };

    let mut by_id: std::collections::HashMap<String, serde_json::Value> = Default::default();
    for stroke in parse(&local).into_iter().chain(parse(incoming)) {
        let Some(id) = stroke.get("id").and_then(|v| v.as_str()) else {
            continue;
        };
        if id.is_empty() {
            continue;
        }
        match by_id.get(id) {
            Some(prev) if date_of(prev) >= date_of(&stroke) => {}
            _ => {
                by_id.insert(id.to_string(), stroke);
            }
        }
    }
    serde_json::to_string_pretty(&by_id.into_values().collect::<Vec<_>>())
        .unwrap_or_else(|_| "[]".into())
}

/// Downloads the desktop's zip sync bundle and extracts `courses/<id>/**`
/// straight into Documents/courses. The whole payload stays in Rust: no JSON,
/// no base64, no webview round-trips.
#[tauri::command]
pub async fn sync_fetch_bundle_zip(app: tauri::AppHandle, url: String) -> Result<SyncZipSummary, String> {
    let bytes = download_with_progress(&app, &url).await?;
    extract_sync_zip(&app, &bytes)
}

/// Same as `sync_fetch_bundle_zip`, but for a bundle the desktop already
/// packed to disk via `/api/sync/bundle/prepare` — the webview watched the
/// packing progress there and hands us the download URL.
#[tauri::command]
pub async fn sync_fetch_prepared_zip(app: tauri::AppHandle, url: String) -> Result<SyncZipSummary, String> {
    let bytes = download_with_progress(&app, &url).await?;
    extract_sync_zip(&app, &bytes)
}

/// Streams a sync bundle with periodic `sync-progress` events (MB downloaded,
/// and a percent when the server sent a Content-Length).
async fn download_with_progress(app: &tauri::AppHandle, url: &str) -> Result<Vec<u8>, String> {
    let response = tauri_plugin_http::reqwest::get(url)
        .await
        .map_err(|e| format!("Could not reach the desktop app ({e}). Is it running on the same Wi-Fi?"))?;
    if !response.status().is_success() {
        return Err(format!("Desktop returned HTTP {}", response.status()));
    }
    let total: Option<u64> = response
        .headers()
        .get(tauri_plugin_http::reqwest::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok());
    let mut response = response;
    let mut bytes: Vec<u8> = Vec::new();
    let mut last_emitted: u64 = 0;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("Failed to download sync bundle: {e}"))?
    {
        bytes.extend_from_slice(&chunk);
        let loaded = bytes.len() as u64;
        if loaded - last_emitted >= 1024 * 1024 {
            last_emitted = loaded;
            let message = match total {
                Some(total) if total > 0 => format!(
                    "Downloading… {:.1} / {:.1} MB",
                    loaded as f64 / (1024.0 * 1024.0),
                    total as f64 / (1024.0 * 1024.0)
                ),
                _ => format!("Downloading… {:.1} MB", loaded as f64 / (1024.0 * 1024.0)),
            };
            emit_sync_progress(app, message);
        }
    }
    eprintln!(
        "[ios-sync] downloaded sync zip: {:.1} MB",
        bytes.len() as f64 / (1024.0 * 1024.0)
    );
    Ok(bytes)
}

fn extract_sync_zip(app: &tauri::AppHandle, bytes: &[u8]) -> Result<SyncZipSummary, String> {
    use std::io::Read as _;

    let cursor = std::io::Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor).map_err(|e| format!("Invalid sync zip: {e}"))?;
    let courses_dir = courses_root(app);
    let data_dir = courses_dir.parent().unwrap_or(&courses_dir);

    let mut generated_at = String::new();
    let mut llm_config: Option<serde_json::Value> = None;
    let mut prompts: Vec<serde_json::Value> = Vec::new();
    let mut counts: std::collections::BTreeMap<String, (usize, usize)> = Default::default();
    let mut seen_courses: std::collections::BTreeSet<String> = Default::default();
    let mut extracted: usize = 0;

    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|e| format!("Failed to read zip entry {index}: {e}"))?;
        let name = entry
            .name()
            .map_err(|e| format!("Invalid zip entry name at {index}: {e}"))?
            .to_string();
        if entry.is_dir() {
            continue;
        }

        if name == "_sync/meta.json" {
            let mut meta = String::new();
            entry
                .read_to_string(&mut meta)
                .map_err(|e| format!("Failed to read _sync/meta.json: {e}"))?;
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&meta) {
                generated_at = value
                    .get("generatedAt")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();
                llm_config = value.get("llmConfig").cloned().filter(|v| !v.is_null());
                if let Some(list) = value.get("prompts").and_then(|v| v.as_array()) {
                    prompts = list.clone();
                }
                if let Some(groups_val) = value.get("groups") {
                    if let Ok(json_str) = serde_json::to_string_pretty(groups_val) {
                        let _ = crate::course_files::write_groups_json(data_dir, &json_str);
                    }
                }
            }
            continue;
        }

        let Some(rest) = name.strip_prefix("courses/") else {
            continue; // unknown top-level entry — skip
        };
        let Some((course_id, rel)) = rest.split_once('/') else {
            continue;
        };
        let course_id = course_id.to_lowercase();
        if course_id.is_empty() {
            continue;
        }
        // Defense in depth: the server already excludes these.
        if rel
            .split('/')
            .any(|s| s.is_empty() || s == ".." || s == "_backup" || (s.starts_with('.') && s != ".manifest.json" && s != ".checkpoints.json" && s != ".annotations.json"))
        {
            continue;
        }

        let file_path = courses_dir.join(&course_id).join(rel);
        if let Some(parent) = file_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create {parent:?}: {e}"))?;
        }

        if rel == ".annotations.json" && file_path.exists() {
            let mut incoming = String::new();
            entry
                .read_to_string(&mut incoming)
                .map_err(|e| format!("Failed to read annotations for {course_id}: {e}"))?;
            let merged = merge_annotations_lww(&file_path, &incoming);
            std::fs::write(&file_path, merged)
                .map_err(|e| format!("Failed to write annotations for {course_id}: {e}"))?;
        } else {
            let mut file = std::fs::File::create(&file_path)
                .map_err(|e| format!("Failed to create {name:?}: {e}"))?;
            std::io::copy(&mut entry, &mut file)
                .map_err(|e| format!("Failed to extract {name:?}: {e}"))?;
        }

        let counters = counts.entry(course_id.clone()).or_insert((0, 0));
        if rel.starts_with("assets/") {
            counters.1 += 1;
        } else {
            counters.0 += 1;
        }
        extracted += 1;
        if seen_courses.insert(course_id.clone()) {
            emit_sync_progress(app, format!("Importing {course_id}…"));
        } else if extracted % 25 == 0 {
            emit_sync_progress(app, format!("Importing {course_id} — {extracted} files"));
        }
    }

    // Prompts land in the shared data-root layout (Documents/prompts), the
    // same place list_prompts reads from.
    if !prompts.is_empty() {
        let dir = data_dir.join("prompts");
        let _ = std::fs::create_dir_all(&dir);
        for prompt in &prompts {
            let id = prompt.get("id").and_then(|v| v.as_str()).unwrap_or_default();
            let content = prompt.get("content").and_then(|v| v.as_str()).unwrap_or_default();
            if !id.is_empty() && !id.contains('/') && !id.contains("..") {
                let _ = std::fs::write(dir.join(format!("{id}.md")), content);
            }
        }
    }

    let courses: Vec<CourseSyncSummary> = counts
        .into_iter()
        .map(|(course_id, (files, assets))| {
            emit_sync_progress(app, format!("{course_id} — {files} files, {assets} assets"));
            CourseSyncSummary {
                course_id,
                files,
                assets,
            }
        })
        .collect();
    eprintln!("[ios-sync] extracted {} course(s)", courses.len());

    Ok(SyncZipSummary {
        generated_at,
        courses,
        llm_config,
    })
}
