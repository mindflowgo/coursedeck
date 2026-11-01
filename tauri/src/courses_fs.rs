use std::path::PathBuf;
use std::sync::RwLock;
#[cfg(not(target_os = "ios"))]
use tauri::Manager;

use crate::course_files;
use crate::fs_util;

pub use course_files::{LessonBundleResponse, PromptItem};
pub use fs_util::FileEntry as LockerFileEntry;
pub use fs_util::FileEntry as LibraryFileEntry;

static COURSES_ROOT_CACHE: RwLock<Option<PathBuf>> = RwLock::new(None);

pub fn clear_courses_root_cache() {
    if let Ok(mut lock) = COURSES_ROOT_CACHE.write() {
        *lock = None;
    }
}

pub fn get_courses_root_dir(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(lock) = COURSES_ROOT_CACHE.read() {
        if let Some(ref path) = *lock {
            return path.clone();
        }
    }
    let resolved = resolve_courses_root_dir(app);
    if let Ok(mut lock) = COURSES_ROOT_CACHE.write() {
        *lock = Some(resolved.clone());
    }
    resolved
}

#[cfg(target_os = "ios")]
fn resolve_courses_root_dir(app: &tauri::AppHandle) -> PathBuf {
    // Everything lives under Documents (user-visible via the Files app);
    // the desktop resolver chain does not apply.
    crate::mobile::courses_root(app)
}

#[cfg(not(target_os = "ios"))]
fn resolve_courses_root_dir(app: &tauri::AppHandle) -> PathBuf {
    // 0. Custom data_dir from settings.json
    if let Some(val) = crate::settings::get_setting_value(app, "data_dir") {
        if let Some(str_path) = val.as_str() {
            let p = PathBuf::from(str_path).join("courses");
            if p.exists() {
                return p;
            }
        }
    }
    // 1. Env variable DATA_DIR
    if let Ok(data_env) = std::env::var("DATA_DIR") {
        let p = PathBuf::from(data_env).join("courses");
        if p.exists() {
            return p;
        }
    }
    // 2. Relative to current working dir
    if let Ok(cwd) = std::env::current_dir() {
        let candidates = [
            cwd.join("data").join("courses"),
            cwd.join("..").join("data").join("courses"),
            cwd.join("courses"),
        ];
        for c in candidates {
            if c.exists() {
                return c;
            }
        }
    }
    // 3. Portable layout: beside executable
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            let candidate = exe_dir.join("data").join("courses");
            if candidate.exists() {
                return candidate;
            }
        }
    }
    // 4. App data directory (Tauri app_data_dir for com.rezox.coursedeck)
    if let Ok(app_data) = app.path().app_data_dir() {
        let candidates = [
            app_data.join("data").join("courses"),
            app_data.join("courses"),
        ];
        for c in candidates {
            if c.exists() {
                return c;
            }
        }
    }
    // 5. macOS standard app support path
    if let Ok(home) = std::env::var("HOME") {
        let candidates = [
            PathBuf::from(&home).join("Library/Application Support/com.rezox.coursedeck/data/courses"),
            PathBuf::from(&home).join("Library/Application Support/com.rezox.coursedeck/courses"),
        ];
        for c in candidates {
            if c.exists() {
                return c;
            }
        }
    }
    // 6. Windows standard AppData Roaming path
    let win_appdata = std::env::var("APPDATA")
        .or_else(|_| std::env::var("USERPROFILE").map(|h| format!("{h}\\AppData\\Roaming")));
    if let Ok(appdata_str) = win_appdata {
        let base = PathBuf::from(appdata_str);
        let candidates = [
            base.join("com.rezox.coursedeck").join("data").join("courses"),
            base.join("com.rezox.coursedeck").join("courses"),
        ];
        for c in candidates {
            if c.exists() {
                return c;
            }
        }
    }
    // Fallback: cwd/data/courses
    std::env::current_dir()
        .map(|cwd| cwd.join("data").join("courses"))
        .unwrap_or_else(|_| PathBuf::from("./data/courses"))
}

pub fn find_course_dir(app: &tauri::AppHandle, course_id: &str) -> Option<PathBuf> {
    let lower_id = course_id.to_lowercase();
    let root = get_courses_root_dir(app);
    let target = root.join(&lower_id);
    if target.exists() {
        return Some(target);
    }

    if let Ok(cwd) = std::env::current_dir() {
        let candidates = [
            cwd.join("data").join("courses").join(&lower_id),
            cwd.join("..").join("data").join("courses").join(&lower_id),
            cwd.join("courses").join(&lower_id),
        ];
        for c in candidates {
            if c.exists() {
                return Some(c);
            }
        }
    }

    Some(target)
}

fn data_dir(app: &tauri::AppHandle) -> PathBuf {
    let root = get_courses_root_dir(app);
    root.parent().unwrap_or(&root).to_path_buf()
}

// ── Courses & lessons ─────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_lesson_bundle(
    app: tauri::AppHandle,
    course_id: String,
    lesson_id: String,
) -> Result<LessonBundleResponse, String> {
    course_files::lesson_bundle(&get_courses_root_dir(&app), &course_id, &lesson_id)
}

#[tauri::command]
pub fn read_course_doc(
    app: tauri::AppHandle,
    course_id: String,
    filename: String,
) -> Result<Option<String>, String> {
    course_files::read_course_doc(&get_courses_root_dir(&app), &course_id, &filename)
}

#[tauri::command]
pub fn save_course_doc(
    app: tauri::AppHandle,
    course_id: String,
    filename: String,
    content: String,
) -> Result<(), String> {
    course_files::save_course_doc(&get_courses_root_dir(&app), &course_id, &filename, &content)
}

#[tauri::command]
pub fn delete_course_doc(
    app: tauri::AppHandle,
    course_id: String,
    filename: String,
) -> Result<bool, String> {
    course_files::delete_course_doc(&get_courses_root_dir(&app), &course_id, &filename)
}

#[tauri::command]
pub fn list_cached_courses(app: tauri::AppHandle) -> Result<Vec<serde_json::Value>, String> {
    let root = get_courses_root_dir(&app);
    let courses = course_files::list_cached_courses(&root);
    eprintln!("[Desktop-Native] list_cached_courses: found {} courses in {root:?}", courses.len());
    Ok(courses)
}

#[tauri::command]
pub fn get_cached_course(
    app: tauri::AppHandle,
    course_id: String,
) -> Result<Option<serde_json::Value>, String> {
    course_files::get_cached_course(&get_courses_root_dir(&app), &course_id)
}

#[tauri::command]
pub fn delete_course(app: tauri::AppHandle, course_id: String) -> Result<bool, String> {
    let root = get_courses_root_dir(&app);
    // Belt and braces: the primary target plus any cwd-resolved duplicate.
    let mut deleted = course_files::delete_course(&root, &course_id)?;
    if let Some(dir) = find_course_dir(&app, &course_id) {
        if dir.exists() && dir != course_files::course_dir(&root, &course_id) {
            std::fs::remove_dir_all(&dir)
                .map_err(|e| format!("Failed to delete course directory {dir:?}: {e}"))?;
            deleted = true;
        }
    }
    eprintln!("[Desktop-Native] delete_course: deleted course '{}' (found={deleted})", course_id.to_lowercase());
    Ok(deleted)
}

// ── Checkpoints & annotations ─────────────────────────────────────────────────

#[tauri::command]
pub fn get_cached_checkpoints(
    app: tauri::AppHandle,
    course_id: String,
) -> Result<Vec<serde_json::Value>, String> {
    Ok(course_files::get_cached_checkpoints(&get_courses_root_dir(&app), &course_id))
}

#[tauri::command]
pub fn save_checkpoint(
    app: tauri::AppHandle,
    course_id: String,
    checkpoint: serde_json::Value,
) -> Result<(), String> {
    course_files::save_checkpoint(&get_courses_root_dir(&app), &course_id, checkpoint)
}

#[tauri::command]
pub fn delete_checkpoint(
    app: tauri::AppHandle,
    course_id: String,
    checkpoint_id: String,
) -> Result<(), String> {
    course_files::delete_checkpoint(&get_courses_root_dir(&app), &course_id, &checkpoint_id)
}

#[tauri::command]
pub fn get_annotations(app: tauri::AppHandle, course_id: String) -> Result<Option<String>, String> {
    course_files::get_annotations(&get_courses_root_dir(&app), &course_id)
}

#[tauri::command]
pub fn save_annotations(
    app: tauri::AppHandle,
    course_id: String,
    strokes_json: String,
) -> Result<(), String> {
    course_files::save_annotations(&get_courses_root_dir(&app), &course_id, &strokes_json)
}

// ── Prompts ───────────────────────────────────────────────────────────────────

pub fn get_prompts_dir(app: &tauri::AppHandle) -> PathBuf {
    let root = get_courses_root_dir(app);
    if let Some(parent) = root.parent() {
        let p = parent.join("prompts");
        if p.exists() {
            return p;
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        let candidates = [
            cwd.join("data").join("prompts"),
            cwd.join("..").join("data").join("prompts"),
            cwd.join("prompts"),
        ];
        for c in candidates {
            if c.exists() {
                return c;
            }
        }
    }
    root.join("..").join("prompts")
}

#[tauri::command]
pub fn list_prompts(app: tauri::AppHandle) -> Result<Vec<PromptItem>, String> {
    Ok(course_files::list_prompts(&get_prompts_dir(&app)))
}

#[tauri::command]
pub fn save_prompt(app: tauri::AppHandle, id: String, content: String) -> Result<(), String> {
    course_files::save_prompt(&get_prompts_dir(&app), &id, &content).map(|_| ())
}

#[tauri::command]
pub fn delete_prompt(app: tauri::AppHandle, id: String) -> Result<(), String> {
    course_files::delete_prompt(&get_prompts_dir(&app), &id)
}

// ── Groups ────────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_groups_json(app: tauri::AppHandle) -> Result<String, String> {
    course_files::read_groups_json(&data_dir(&app))
}

#[tauri::command]
pub fn save_groups_json(app: tauri::AppHandle, content: String) -> Result<(), String> {
    course_files::write_groups_json(&data_dir(&app), &content)
}

// ── Locker docs (course assets/locker_docs, always local) ─────────────────────

fn locker_docs_dir(app: &tauri::AppHandle, course_id: &str) -> Result<PathBuf, String> {
    let course_dir = find_course_dir(app, course_id)
        .ok_or_else(|| format!("Could not resolve course dir for '{course_id}'"))?;
    Ok(course_dir.join("assets").join("locker_docs"))
}

#[tauri::command]
pub fn list_locker_docs(
    app: tauri::AppHandle,
    course_id: String,
) -> Result<Vec<LockerFileEntry>, String> {
    Ok(fs_util::list_files(&locker_docs_dir(&app, &course_id)?, |_| true))
}

/// Bytes are the raw IPC body; `course-id` and percent-encoded `filename`
/// travel as headers (see fs_util::save_doc_raw).
#[tauri::command]
pub fn save_locker_doc(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<LockerFileEntry, String> {
    let course_id = fs_util::request_header(&request, "course-id");
    let dir = locker_docs_dir(&app, &course_id)?;
    let entry = fs_util::save_doc_raw(&request, &dir)?;
    eprintln!(
        "[Desktop-Native] save_locker_doc: saved {}/{} ({} bytes)",
        dir.display(),
        entry.filename,
        entry.size
    );
    Ok(entry)
}

#[tauri::command]
pub fn delete_locker_doc(
    app: tauri::AppHandle,
    course_id: String,
    filename: String,
) -> Result<bool, String> {
    fs_util::delete_file_in(&locker_docs_dir(&app, &course_id)?, &filename)
}

/// Raw bytes of a locker doc — used by the sync push to upload files that
/// live on this device's disk.
#[tauri::command]
pub fn read_locker_doc(
    app: tauri::AppHandle,
    course_id: String,
    filename: String,
) -> Result<tauri::ipc::Response, String> {
    let dir = locker_docs_dir(&app, &course_id)?;
    let bytes = fs_util::read_doc_bytes(&dir, &filename)?;
    Ok(tauri::ipc::Response::new(bytes))
}

// ── Library (data_dir/library) ────────────────────────────────────────────────

pub fn get_library_dir(app: &tauri::AppHandle) -> PathBuf {
    let lib = data_dir(app).join("library");
    if !lib.exists() {
        let _ = std::fs::create_dir_all(&lib);
    }
    lib
}

#[tauri::command]
pub fn get_library_manifest(app: tauri::AppHandle) -> Result<String, String> {
    fs_util::read_json_file(&get_library_dir(&app), ".manifest.json", "{\"version\":1,\"documents\":[]}")
}

#[tauri::command]
pub fn save_library_manifest(app: tauri::AppHandle, content: String) -> Result<(), String> {
    fs_util::write_json_atomic(&get_library_dir(&app), ".manifest.json", &content)?;
    eprintln!("[Desktop-Native] save_library_manifest: saved");
    Ok(())
}

#[tauri::command]
pub fn get_library_annotations(app: tauri::AppHandle) -> Result<Option<String>, String> {
    fs_util::read_json_file(&get_library_dir(&app), ".annotations.json", "")
        .map(|s| if s.is_empty() { None } else { Some(s) })
}

#[tauri::command]
pub fn save_library_annotations(app: tauri::AppHandle, content: String) -> Result<(), String> {
    fs_util::write_json_atomic(&get_library_dir(&app), ".annotations.json", &content)?;
    eprintln!("[Desktop-Native] save_library_annotations: saved");
    Ok(())
}

#[tauri::command]
pub fn get_library_checkpoints(app: tauri::AppHandle) -> Result<String, String> {
    fs_util::read_json_file(&get_library_dir(&app), ".checkpoints.json", "[]")
}

#[tauri::command]
pub fn save_library_checkpoints(app: tauri::AppHandle, content: String) -> Result<(), String> {
    fs_util::write_json_atomic(&get_library_dir(&app), ".checkpoints.json", &content)?;
    eprintln!("[Desktop-Native] save_library_checkpoints: saved");
    Ok(())
}

#[tauri::command]
pub fn delete_library_doc(app: tauri::AppHandle, filename: String) -> Result<bool, String> {
    fs_util::delete_file_in(&get_library_dir(&app), &filename)
}

/// Bytes are the raw IPC body; the percent-encoded filename travels in a
/// header (see fs_util::save_doc_raw).
#[tauri::command]
pub fn save_library_doc(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<LibraryFileEntry, String> {
    let entry = fs_util::save_doc_raw(&request, &get_library_dir(&app))?;
    eprintln!(
        "[Desktop-Native] save_library_doc: saved {} ({} bytes)",
        entry.filename,
        entry.size
    );
    Ok(entry)
}

#[tauri::command]
pub fn list_library_docs(app: tauri::AppHandle) -> Result<Vec<LibraryFileEntry>, String> {
    Ok(fs_util::list_files(&get_library_dir(&app), fs_util::is_library_document))
}

#[cfg(test)]
mod tests {
    #[test]
    fn test_normalize_lesson_id() {
        assert_eq!(crate::course_files::normalize_lesson_id("1.2"), "01.02");
        assert_eq!(crate::course_files::normalize_lesson_id("01.02"), "01.02");
        assert_eq!(crate::course_files::normalize_lesson_id("1.10"), "01.10");
        assert_eq!(crate::course_files::normalize_lesson_id("01.06_assign1"), "01.06_assign1");
        assert_eq!(crate::course_files::normalize_lesson_id("course.schedule"), "course.schedule");
    }
}
