use std::collections::HashMap;
use std::path::PathBuf;
use tauri::Manager;

pub mod pdf;

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
pub struct LessonBundleResponse {
    pub course_id: String,
    pub lesson_id: String,
    pub lesson: String,
    pub tabs: HashMap<String, String>,
}

fn get_courses_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    // Courses live in Documents/courses so synced material is user-visible in
    // the Files app (UIFileSharingEnabled); app-support is the off-device
    // fallback for platforms without a Documents directory.
    let base = match app.path().document_dir() {
        Ok(documents) => documents,
        Err(_) => app
            .path()
            .app_data_dir()
            .map_err(|e| format!("Failed to get app_data_dir: {e}"))?,
    };
    let courses_dir = base.join("courses");
    if !courses_dir.exists() {
        std::fs::create_dir_all(&courses_dir)
            .map_err(|e| format!("Failed to create courses dir: {e}"))?;
    }
    Ok(courses_dir)
}

/// Parses `courseasset://` URIs (see `pdf::parse_course_asset_uri` in the
/// shared pdf module, compiled into both the desktop and iPad crates).
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
fn serve_course_asset(
    app: &tauri::AppHandle,
    uri: &str,
) -> tauri::http::Response<Vec<u8>> {
    let respond = |status: u16, content_type: &str, body: Vec<u8>| {
        tauri::http::Response::builder()
            .status(status)
            .header("Content-Type", content_type)
            .header("Cache-Control", "public, max-age=86400")
            .body(body)
            .unwrap_or_else(|_| tauri::http::Response::new(Vec::new()))
    };

    let Some((course_id, rel)) = pdf::parse_course_asset_uri(uri) else {
        return respond(400, "text/plain; charset=utf-8", b"invalid courseasset URI".to_vec());
    };

    let file_path = match get_courses_dir(app) {
        Ok(dir) => dir.join(&course_id).join(&rel),
        Err(e) => return respond(500, "text/plain; charset=utf-8", e.into_bytes()),
    };

    match std::fs::read(&file_path) {
        Ok(bytes) => respond(200, asset_content_type(&file_path), bytes),
        Err(e) => respond(
            404,
            "text/plain; charset=utf-8",
            format!("asset not found: {rel} ({e})").into_bytes(),
        ),
    }
}

fn normalize_lesson_id(s: &str) -> String {
    let s = s.trim().to_lowercase();
    if let Some(pos) = s.find('.') {
        let (first, rest) = s.split_at(pos);
        let rest = &rest[1..];
        if let Ok(u) = first.parse::<u32>() {
            let mut digits_end = 0;
            for (idx, ch) in rest.char_indices() {
                if ch.is_ascii_digit() {
                    digits_end = idx + 1;
                } else {
                    break;
                }
            }
            if digits_end > 0 {
                if let Ok(l) = rest[..digits_end].parse::<u32>() {
                    let suffix = &rest[digits_end..];
                    return format!("{:02}.{:02}{}", u, l, suffix);
                }
            }
        }
    }
    s
}

// ── Zip Sync (iPad ← desktop bundle archive) ──────────────────────────────────

#[derive(serde::Serialize)]
struct CourseSyncSummary {
    course_id: String,
    files: usize,
    assets: usize,
}

#[derive(serde::Serialize)]
struct SyncZipSummary {
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
    let parse = |s: &str| -> Vec<serde_json::Value> {
        serde_json::from_str(s).unwrap_or_default()
    };
    let local = std::fs::read_to_string(existing_path).unwrap_or_default();
    let date_of = |v: &serde_json::Value| -> String {
        v.get("date").and_then(|d| d.as_str()).unwrap_or_default().to_string()
    };

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
async fn sync_fetch_bundle_zip(app: tauri::AppHandle, url: String) -> Result<SyncZipSummary, String> {
    let response = tauri_plugin_http::reqwest::get(&url)
        .await
        .map_err(|e| format!("Could not reach the desktop app ({e}). Is it running on the same Wi-Fi?"))?;
    if !response.status().is_success() {
        return Err(format!("Desktop returned HTTP {}", response.status()));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Failed to download sync bundle: {e}"))?;
    eprintln!(
        "[tauripad-sync] downloaded sync zip: {:.1} MB",
        bytes.len() as f64 / (1024.0 * 1024.0)
    );

    extract_sync_zip(&app, &bytes)
}

fn extract_sync_zip(app: &tauri::AppHandle, bytes: &[u8]) -> Result<SyncZipSummary, String> {
    use std::io::Read as _;

    let cursor = std::io::Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor).map_err(|e| format!("Invalid sync zip: {e}"))?;
    let courses_dir = get_courses_dir(app)?;

    let mut generated_at = String::new();
    let mut llm_config: Option<serde_json::Value> = None;
    let mut prompts: Vec<serde_json::Value> = Vec::new();
    let mut counts: std::collections::BTreeMap<String, (usize, usize)> = Default::default();

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
            .any(|s| s.is_empty() || s == ".." || s == "_backup" || s.starts_with('.'))
        {
            continue;
        }

        let file_path = courses_dir.join(&course_id).join(rel);
        if let Some(parent) = file_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create {:?}: {e}", parent))?;
        }

        if rel == "annotations.json" && file_path.exists() {
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

        let counters = counts.entry(course_id).or_insert((0, 0));
        if rel.starts_with("assets/") {
            counters.1 += 1;
        } else {
            counters.0 += 1;
        }
    }

    if !prompts.is_empty() {
        if let Ok(app_data) = app.path().app_data_dir() {
            let dir = app_data.join("prompts");
            let _ = std::fs::create_dir_all(&dir);
            for prompt in &prompts {
                let id = prompt.get("id").and_then(|v| v.as_str()).unwrap_or_default();
                let content = prompt.get("content").and_then(|v| v.as_str()).unwrap_or_default();
                if !id.is_empty() && !id.contains('/') && !id.contains("..") {
                    let _ = std::fs::write(dir.join(format!("{id}.md")), content);
                }
            }
        }
    }

    let courses: Vec<CourseSyncSummary> = counts
        .into_iter()
        .map(|(course_id, (files, assets))| CourseSyncSummary {
            course_id,
            files,
            assets,
        })
        .collect();
    eprintln!("[tauripad-sync] extracted {} course(s)", courses.len());

    Ok(SyncZipSummary {
        generated_at,
        courses,
        llm_config,
    })
}

#[tauri::command]
fn get_lesson_bundle(
    app: tauri::AppHandle,
    course_id: String,
    lesson_id: String,
) -> Result<LessonBundleResponse, String> {
    let courses_dir = get_courses_dir(&app)?;
    let course_dir = courses_dir.join(course_id.to_lowercase());
    if !course_dir.exists() {
        eprintln!(
            "[tauripad-fs] get_lesson_bundle: course dir does not exist: {:?}",
            course_dir
        );
        return Ok(LessonBundleResponse {
            course_id,
            lesson_id,
            lesson: String::new(),
            tabs: HashMap::new(),
        });
    }

    let target_norm = normalize_lesson_id(&lesson_id);
    let target_raw = lesson_id.trim().to_lowercase();

    let mut lesson_content = String::new();
    let mut tabs = HashMap::new();
    let mut matched_files = Vec::new();

    let entries = std::fs::read_dir(&course_dir)
        .map_err(|e| format!("Failed to read course dir {:?}: {e}", course_dir))?;

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let file_name = entry.file_name().to_string_lossy().to_string();
        if !file_name.ends_with(".md") {
            continue;
        }

        // e.g. "01.01.lesson.md" -> strip ".md" -> "01.01.lesson"
        let without_ext = &file_name[..file_name.len() - 3];
        if let Some(last_dot) = without_ext.rfind('.') {
            let file_lesson = &without_ext[..last_dot];
            let file_tab = &without_ext[last_dot + 1..];

            let file_norm = normalize_lesson_id(file_lesson);
            let file_raw = file_lesson.trim().to_lowercase();

            if file_norm == target_norm || file_raw == target_raw {
                if let Ok(content) = std::fs::read_to_string(&path) {
                    matched_files.push(file_name.clone());
                    if file_tab == "lesson" {
                        lesson_content = content;
                    } else {
                        tabs.insert(file_tab.to_string(), content);
                    }
                }
            }
        }
    }

    eprintln!(
        "[tauripad-fs] get_lesson_bundle: course={} lesson_id={} (norm={}) matched {} files: {:?}, has_lesson={}, tabs={:?}",
        course_id,
        lesson_id,
        target_norm,
        matched_files.len(),
        matched_files,
        !lesson_content.is_empty(),
        tabs.keys().collect::<Vec<_>>()
    );

    Ok(LessonBundleResponse {
        course_id,
        lesson_id,
        lesson: lesson_content,
        tabs,
    })
}

#[tauri::command]
fn read_course_doc(
    app: tauri::AppHandle,
    course_id: String,
    filename: String,
) -> Result<Option<String>, String> {
    let courses_dir = get_courses_dir(&app)?;
    let file_path = courses_dir.join(course_id.to_lowercase()).join(&filename);
    if file_path.exists() {
        let content = std::fs::read_to_string(&file_path)
            .map_err(|e| format!("Failed to read {:?}: {e}", file_path))?;
        eprintln!(
            "[tauripad-fs] read_course_doc: read {} bytes from {:?}",
            content.len(),
            file_path
        );
        Ok(Some(content))
    } else {
        eprintln!(
            "[tauripad-fs] read_course_doc: file not found {:?}",
            file_path
        );
        Ok(None)
    }
}

#[tauri::command]
fn save_course_doc(
    app: tauri::AppHandle,
    course_id: String,
    filename: String,
    content: String,
) -> Result<(), String> {
    let courses_dir = get_courses_dir(&app)?;
    let course_dir = courses_dir.join(course_id.to_lowercase());
    std::fs::create_dir_all(&course_dir)
        .map_err(|e| format!("Failed to create course dir {:?}: {e}", course_dir))?;
    let file_path = course_dir.join(&filename);
    std::fs::write(&file_path, content)
        .map_err(|e| format!("Failed to write {:?}: {e}", file_path))?;
    eprintln!(
        "[tauripad-fs] save_course_doc: saved {:?}",
        file_path
    );
    Ok(())
}

#[tauri::command]
fn delete_course_doc(
    app: tauri::AppHandle,
    course_id: String,
    filename: String,
) -> Result<bool, String> {
    let courses_dir = get_courses_dir(&app)?;
    let course_dir = courses_dir.join(course_id.to_lowercase());
    if !course_dir.exists() {
        return Ok(false);
    }

    // 1. Direct path check
    let direct_path = course_dir.join(&filename);
    if direct_path.exists() {
        std::fs::remove_file(&direct_path)
            .map_err(|e| format!("Failed to delete {:?}: {e}", direct_path))?;
        eprintln!("[tauripad-fs] delete_course_doc: deleted {:?}", direct_path);
        return Ok(true);
    }

    // 2. If filename has lesson prefix like 1.1.tab.md, check normalized candidate
    if let Some(last_dot) = filename[..filename.len().saturating_sub(3)].rfind('.') {
        let file_lesson = &filename[..last_dot];
        let file_tab = &filename[last_dot + 1..filename.len().saturating_sub(3)];
        let norm_lesson = normalize_lesson_id(file_lesson);
        let norm_filename = format!("{norm_lesson}.{file_tab}.md");
        let norm_path = course_dir.join(&norm_filename);
        if norm_path.exists() {
            std::fs::remove_file(&norm_path)
                .map_err(|e| format!("Failed to delete {:?}: {e}", norm_path))?;
            eprintln!("[tauripad-fs] delete_course_doc: deleted {:?}", norm_path);
            return Ok(true);
        }
    }

    Ok(false)
}

#[tauri::command]
fn list_cached_courses(app: tauri::AppHandle) -> Result<Vec<serde_json::Value>, String> {
    let courses_dir = get_courses_dir(&app)?;
    let mut courses = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&courses_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let meta_path = if path.join("meta.json").exists() {
                    path.join("meta.json")
                } else {
                    path.join("manifest.json")
                };
                if meta_path.exists() {
                    if let Ok(raw) = std::fs::read_to_string(&meta_path) {
                        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&raw) {
                            courses.push(val);
                        }
                    }
                }
            }
        }
    }
    eprintln!(
        "[tauripad-fs] list_cached_courses: found {} courses on disk in {:?}",
        courses.len(),
        courses_dir
    );
    Ok(courses)
}

#[tauri::command]
fn get_cached_course(
    app: tauri::AppHandle,
    course_id: String,
) -> Result<Option<serde_json::Value>, String> {
    let courses_dir = get_courses_dir(&app)?;
    let course_dir = courses_dir.join(course_id.to_lowercase());
    let meta_path = if course_dir.join("meta.json").exists() {
        course_dir.join("meta.json")
    } else {
        course_dir.join("manifest.json")
    };
    if meta_path.exists() {
        let raw = std::fs::read_to_string(&meta_path)
            .map_err(|e| format!("Failed to read manifest {:?}: {e}", meta_path))?;
        let val = serde_json::from_str(&raw)
            .map_err(|e| format!("Failed to parse manifest: {e}"))?;
        Ok(Some(val))
    } else {
        Ok(None)
    }
}

#[tauri::command]
fn delete_course(
    app: tauri::AppHandle,
    course_id: String,
) -> Result<bool, String> {
    let courses_dir = get_courses_dir(&app)?;
    let course_dir = courses_dir.join(course_id.to_lowercase());
    if course_dir.exists() {
        std::fs::remove_dir_all(&course_dir)
            .map_err(|e| format!("Failed to delete course directory {:?}: {e}", course_dir))?;
        eprintln!("[tauripad-fs] delete_course: deleted course '{:?}'", course_dir);
        Ok(true)
    } else {
        Ok(false)
    }
}

#[tauri::command]
fn get_cached_checkpoints(
    app: tauri::AppHandle,
    course_id: String,
) -> Result<Vec<serde_json::Value>, String> {
    let courses_dir = get_courses_dir(&app)?;
    let course_dir = courses_dir.join(course_id.to_lowercase());
    let cp_path = if course_dir.join("checkpoints.json").exists() {
        course_dir.join("checkpoints.json")
    } else {
        course_dir.join("checkpoint.json")
    };
    if cp_path.exists() {
        let raw = std::fs::read_to_string(&cp_path).unwrap_or_default();
        let val = serde_json::from_str(&raw).unwrap_or_else(|_| serde_json::Value::Array(Vec::new()));
        if let serde_json::Value::Array(arr) = val {
            return Ok(arr);
        }
    }
    Ok(Vec::new())
}

#[tauri::command]
fn save_checkpoint(
    app: tauri::AppHandle,
    course_id: String,
    checkpoint: serde_json::Value,
) -> Result<(), String> {
    let courses_dir = get_courses_dir(&app)?;
    let course_dir = courses_dir.join(course_id.to_lowercase());
    std::fs::create_dir_all(&course_dir)
        .map_err(|e| format!("Failed to create dir {:?}: {e}", course_dir))?;
    let cp_path = course_dir.join("checkpoints.json");
    let legacy_path = course_dir.join("checkpoint.json");
    let mut list = if cp_path.exists() {
        let raw = std::fs::read_to_string(&cp_path).unwrap_or_default();
        serde_json::from_str::<Vec<serde_json::Value>>(&raw).unwrap_or_default()
    } else if legacy_path.exists() {
        let raw = std::fs::read_to_string(&legacy_path).unwrap_or_default();
        serde_json::from_str::<Vec<serde_json::Value>>(&raw).unwrap_or_default()
    } else {
        Vec::new()
    };

    let target_id = checkpoint.get("id").and_then(|v| v.as_str()).unwrap_or("");
    if let Some(pos) = list
        .iter()
        .position(|c| c.get("id").and_then(|v| v.as_str()) == Some(target_id))
    {
        list[pos] = checkpoint;
    } else {
        list.push(checkpoint);
    }

    let json = serde_json::to_string_pretty(&list)
        .map_err(|e| format!("Serialization error: {e}"))?;
    std::fs::write(&cp_path, &json)
        .map_err(|e| format!("Failed to write checkpoints: {e}"))?;
    if legacy_path.exists() {
        let _ = std::fs::remove_file(&legacy_path);
    }
    Ok(())
}

#[tauri::command]
fn delete_checkpoint(
    app: tauri::AppHandle,
    course_id: String,
    checkpoint_id: String,
) -> Result<(), String> {
    let courses_dir = get_courses_dir(&app)?;
    let course_dir = courses_dir.join(course_id.to_lowercase());
    let cp_path = course_dir.join("checkpoints.json");
    let legacy_path = course_dir.join("checkpoint.json");
    let list_opt = if cp_path.exists() {
        let raw = std::fs::read_to_string(&cp_path).unwrap_or_default();
        serde_json::from_str::<Vec<serde_json::Value>>(&raw).ok()
    } else if legacy_path.exists() {
        let raw = std::fs::read_to_string(&legacy_path).unwrap_or_default();
        serde_json::from_str::<Vec<serde_json::Value>>(&raw).ok()
    } else {
        None
    };
    if let Some(list) = list_opt {
        let filtered: Vec<_> = list
            .into_iter()
            .filter(|c| c.get("id").and_then(|v| v.as_str()) != Some(&checkpoint_id))
            .collect();
        let json = serde_json::to_string_pretty(&filtered)
            .map_err(|e| format!("Serialization error: {e}"))?;
        std::fs::write(&cp_path, &json)
            .map_err(|e| format!("Failed to write checkpoints: {e}"))?;
        if legacy_path.exists() {
            let _ = std::fs::remove_file(&legacy_path);
        }
    }
    Ok(())
}

// ── Markup annotations (annotations.json per course) ──────────────────────────
// The webview sends the already-merged full stroke array (LWW applied in JS),
// so these commands are a plain read/write of the JSON file.

#[tauri::command]
fn get_annotations(app: tauri::AppHandle, course_id: String) -> Result<Option<String>, String> {
    let courses_dir = get_courses_dir(&app)?;
    let path = courses_dir.join(course_id.to_lowercase()).join("annotations.json");
    if path.exists() {
        match std::fs::read_to_string(&path) {
            Ok(raw) => return Ok(Some(raw)),
            Err(e) => return Err(format!("Failed to read annotations: {e}")),
        }
    }
    Ok(None)
}

#[tauri::command]
fn save_annotations(
    app: tauri::AppHandle,
    course_id: String,
    strokes_json: String,
) -> Result<(), String> {
    let courses_dir = get_courses_dir(&app)?;
    let course_dir = courses_dir.join(course_id.to_lowercase());
    std::fs::create_dir_all(&course_dir)
        .map_err(|e| format!("Failed to create dir {:?}: {e}", course_dir))?;
    // Validate it is a JSON array before writing
    let parsed: Vec<serde_json::Value> = serde_json::from_str(&strokes_json)
        .map_err(|e| format!("Invalid annotations JSON: {e}"))?;
    let json = serde_json::to_string_pretty(&parsed)
        .map_err(|e| format!("Serialization error: {e}"))?;
    std::fs::write(course_dir.join("annotations.json"), &json)
        .map_err(|e| format!("Failed to write annotations: {e}"))?;
    Ok(())
}

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
pub struct PromptItem {
    pub id: String,
    pub title: String,
    pub filename: String,
    pub content: String,
}

#[tauri::command]
fn save_prompts(app: tauri::AppHandle, prompts: Vec<PromptItem>) -> Result<usize, String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let dir = app_data.join("prompts");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let count = prompts.len();
    for p in prompts {
        let path = dir.join(format!("{}.md", p.id));
        let _ = std::fs::write(&path, &p.content);
    }
    eprintln!("[tauripad-fs] save_prompts: saved {} prompts to {:?}", count, dir);
    Ok(count)
}

#[tauri::command]
fn list_prompts(app: tauri::AppHandle) -> Result<Vec<PromptItem>, String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let dir = app_data.join("prompts");
    let mut list = Vec::new();
    let mut seen_ids = std::collections::HashSet::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() && path.extension().and_then(|e| e.to_str()) == Some("md") {
                let filename = entry.file_name().to_string_lossy().to_string();
                let id = filename.trim_end_matches(".md").to_string();
                if seen_ids.contains(&id) {
                    continue;
                }
                seen_ids.insert(id.clone());
                if let Ok(content) = std::fs::read_to_string(&path) {
                    let title = content
                        .lines()
                        .find(|l| l.starts_with("# "))
                        .map(|l| l[2..].trim().to_string())
                        .unwrap_or_else(|| id.clone());
                    list.push(PromptItem {
                        id,
                        title,
                        filename,
                        content,
                    });
                }
            }
        }
    }
    eprintln!("[tauripad-fs] list_prompts: found {} prompts in {:?}", list.len(), dir);
    Ok(list)
}

#[tauri::command]
fn save_prompt(app: tauri::AppHandle, id: String, content: String) -> Result<(), String> {
    let clean_id = id.trim().trim_end_matches(".md");
    if clean_id.is_empty() || clean_id.contains('/') || clean_id.contains('\\') || clean_id.contains("..") {
        return Err(format!("Invalid prompt ID: {}", clean_id));
    }
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let dir = app_data.join("prompts");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}.md", clean_id));
    std::fs::write(&path, content).map_err(|e| e.to_string())?;
    eprintln!("[tauripad-fs] save_prompt: saved {:?}", path);
    Ok(())
}

#[tauri::command]
fn delete_prompt(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let clean_id = id.trim().trim_end_matches(".md");
    if clean_id.is_empty() || clean_id.contains('/') || clean_id.contains('\\') || clean_id.contains("..") {
        return Err(format!("Invalid prompt ID: {}", clean_id));
    }
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let dir = app_data.join("prompts");
    let path = dir.join(format!("{}.md", clean_id));
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    eprintln!("[tauripad-fs] delete_prompt: deleted {:?}", path);
    Ok(())
}

#[tauri::command]
fn get_storage_path(app: tauri::AppHandle) -> Result<String, String> {
    let courses_dir = get_courses_dir(&app)?;
    Ok(courses_dir.to_string_lossy().to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init());

    #[cfg(mobile)]
    {
        builder = builder.plugin(tauri_plugin_barcode_scanner::init());
    }

    builder = builder.plugin(tauri_plugin_pencilkit::init());

    builder = builder.register_uri_scheme_protocol("courseasset", |ctx, request| {
        serve_course_asset(ctx.app_handle(), &request.uri().to_string())
    });

    builder
        .invoke_handler(tauri::generate_handler![
            sync_fetch_bundle_zip,
            get_lesson_bundle,
            read_course_doc,
            save_course_doc,
            delete_course_doc,
            list_cached_courses,
            get_cached_course,
            delete_course,
            get_cached_checkpoints,
            save_checkpoint,
            delete_checkpoint,
            get_annotations,
            save_annotations,
            get_storage_path,
            save_prompts,
            list_prompts,
            save_prompt,
            delete_prompt,
            pdf::pdf_get_info,
            pdf::pdf_render_page,
            pdf::pdf_render_thumbnail,
            pdf::pdf_get_page_text,
            pdf::pdf_search,
            pdf::pdf_close_document,
        ])
        .setup(|app| {
            let pdf_state = pdf::PdfEngineState(pdf::PdfEngine::new().map(std::sync::Arc::new));
            app.manage(pdf_state);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running CourseDeck iPad application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_lesson_id() {
        assert_eq!(normalize_lesson_id("1.2"), "01.02");
        assert_eq!(normalize_lesson_id("01.02"), "01.02");
        assert_eq!(normalize_lesson_id("1.10"), "01.10");
        assert_eq!(normalize_lesson_id("01.06_assign1"), "01.06_assign1");
        assert_eq!(normalize_lesson_id("course.schedule"), "course.schedule");
    }

    #[test]
    fn test_parse_course_asset_uri() {
        assert_eq!(
            pdf::parse_course_asset_uri(
                "courseasset://localhost/biology_11/assets/locker_docs/fig%202.png"
            ),
            Some(("biology_11".to_string(), "assets/locker_docs/fig 2.png".to_string()))
        );
        assert_eq!(
            pdf::parse_course_asset_uri("courseasset://localhost/b/assets/img/diagram.jpg?x=1"),
            Some(("b".to_string(), "assets/img/diagram.jpg".to_string()))
        );
        // Traversal and non-asset targets are rejected.
        assert_eq!(pdf::parse_course_asset_uri("courseasset://localhost/a/../../etc/passwd"), None);
        assert_eq!(pdf::parse_course_asset_uri("courseasset://localhost/a/meta.json"), None);
        // Other schemes don't match.
        assert_eq!(pdf::parse_course_asset_uri("http://localhost/a/assets/x.png"), None);
        assert_eq!(pdf::parse_course_asset_uri("/api/courses/a/assets/x.png"), None);
    }
}
