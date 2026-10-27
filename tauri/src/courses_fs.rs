use std::collections::HashMap;
use std::path::PathBuf;
use tauri::Manager;

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
pub struct LessonBundleResponse {
    pub course_id: String,
    pub lesson_id: String,
    pub lesson: String,
    pub tabs: HashMap<String, String>,
}

pub fn get_courses_root_dir(app: &tauri::AppHandle) -> PathBuf {
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

#[tauri::command]
pub fn save_course_files(
    app: tauri::AppHandle,
    course_id: String,
    manifest_json: String,
    files: HashMap<String, String>,
    checkpoints_json: Option<String>,
) -> Result<usize, String> {
    let course_dir = find_course_dir(&app, &course_id)
        .ok_or_else(|| format!("Could not resolve course dir for '{course_id}'"))?;
    std::fs::create_dir_all(&course_dir)
        .map_err(|e| format!("Failed to create course dir {:?}: {e}", course_dir))?;

    let manifest_path = course_dir.join("manifest.json");
    std::fs::write(&manifest_path, &manifest_json)
        .map_err(|e| format!("Failed to write manifest.json: {e}"))?;
    let meta_path = course_dir.join("meta.json");
    let _ = std::fs::write(&meta_path, &manifest_json);

    let count = files.len();
    for (filename, content) in files {
        let file_path = course_dir.join(&filename);
        std::fs::write(&file_path, content)
            .map_err(|e| format!("Failed to write file {:?}: {e}", file_path))?;
    }

    if let Some(cp_json) = checkpoints_json {
        let cp_path = course_dir.join("checkpoints.json");
        let _ = std::fs::write(&cp_path, &cp_json);
        let legacy = course_dir.join("checkpoint.json");
        if legacy.exists() {
            let _ = std::fs::remove_file(&legacy);
        }
    }

    eprintln!(
        "[Desktop-Native] save_course_files: wrote {} files for course {} to {:?}",
        count, course_id, course_dir
    );

    Ok(count)
}

#[tauri::command]
pub fn get_lesson_bundle(
    app: tauri::AppHandle,
    course_id: String,
    lesson_id: String,
) -> Result<LessonBundleResponse, String> {
    let course_dir = match find_course_dir(&app, &course_id) {
        Some(d) => d,
        None => {
            return Ok(LessonBundleResponse {
                course_id,
                lesson_id,
                lesson: String::new(),
                tabs: HashMap::new(),
            });
        }
    };

    if !course_dir.exists() {
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
        "[Desktop-Native] get_lesson_bundle: course={} lesson_id={} (norm={}) matched {} files: {:?}, has_lesson={}, tabs={:?}",
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
pub fn read_course_doc(
    app: tauri::AppHandle,
    course_id: String,
    filename: String,
) -> Result<Option<String>, String> {
    if let Some(course_dir) = find_course_dir(&app, &course_id) {
        let file_path = course_dir.join(&filename);
        if file_path.exists() {
            let content = std::fs::read_to_string(&file_path)
                .map_err(|e| format!("Failed to read {:?}: {e}", file_path))?;
            eprintln!(
                "[Desktop-Native] read_course_doc: read {} chars from {:?}",
                content.len(),
                file_path
            );
            return Ok(Some(content));
        }
    }
    Ok(None)
}

#[tauri::command]
pub fn save_course_doc(
    app: tauri::AppHandle,
    course_id: String,
    filename: String,
    content: String,
) -> Result<(), String> {
    let course_dir = find_course_dir(&app, &course_id)
        .ok_or_else(|| format!("Could not resolve course dir for '{course_id}'"))?;
    std::fs::create_dir_all(&course_dir)
        .map_err(|e| format!("Failed to create course dir {:?}: {e}", course_dir))?;
    let file_path = course_dir.join(&filename);
    std::fs::write(&file_path, content)
        .map_err(|e| format!("Failed to write {:?}: {e}", file_path))?;
    eprintln!("[Desktop-Native] save_course_doc: saved {:?}", file_path);
    Ok(())
}

#[tauri::command]
pub fn delete_course_doc(
    app: tauri::AppHandle,
    course_id: String,
    filename: String,
) -> Result<bool, String> {
    if let Some(course_dir) = find_course_dir(&app, &course_id) {
        if !course_dir.exists() {
            return Ok(false);
        }

        // 1. Direct path check
        let direct_path = course_dir.join(&filename);
        if direct_path.exists() {
            std::fs::remove_file(&direct_path)
                .map_err(|e| format!("Failed to delete {:?}: {e}", direct_path))?;
            eprintln!("[Desktop-Native] delete_course_doc: deleted {:?}", direct_path);
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
                eprintln!("[Desktop-Native] delete_course_doc: deleted {:?}", norm_path);
                return Ok(true);
            }
        }
    }
    Ok(false)
}

#[tauri::command]
pub fn list_cached_courses(app: tauri::AppHandle) -> Result<Vec<serde_json::Value>, String> {
    let courses_dir = get_courses_root_dir(&app);
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
        "[Desktop-Native] list_cached_courses: found {} courses in {:?}",
        courses.len(),
        courses_dir
    );
    Ok(courses)
}

#[tauri::command]
pub fn get_cached_course(
    app: tauri::AppHandle,
    course_id: String,
) -> Result<Option<serde_json::Value>, String> {
    if let Some(course_dir) = find_course_dir(&app, &course_id) {
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
            return Ok(Some(val));
        }
    }
    Ok(None)
}

#[tauri::command]
pub fn delete_course(
    app: tauri::AppHandle,
    course_id: String,
) -> Result<bool, String> {
    let lower_id = course_id.to_lowercase();
    let mut deleted = false;

    if let Some(course_dir) = find_course_dir(&app, &lower_id) {
        if course_dir.exists() {
            std::fs::remove_dir_all(&course_dir)
                .map_err(|e| format!("Failed to delete course directory {:?}: {e}", course_dir))?;
            deleted = true;
        }
    }

    let root = get_courses_root_dir(&app);
    let target = root.join(&lower_id);
    if target.exists() {
        std::fs::remove_dir_all(&target)
            .map_err(|e| format!("Failed to delete course directory {:?}: {e}", target))?;
        deleted = true;
    }

    eprintln!("[Desktop-Native] delete_course: deleted course '{}' (found={deleted})", lower_id);
    Ok(deleted)
}

#[tauri::command]
pub fn get_cached_checkpoints(
    app: tauri::AppHandle,
    course_id: String,
) -> Result<Vec<serde_json::Value>, String> {
    if let Some(course_dir) = find_course_dir(&app, &course_id) {
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
    }
    Ok(Vec::new())
}

#[tauri::command]
pub fn save_checkpoint(
    app: tauri::AppHandle,
    course_id: String,
    checkpoint: serde_json::Value,
) -> Result<(), String> {
    let course_dir = find_course_dir(&app, &course_id)
        .ok_or_else(|| format!("Could not resolve course dir for '{course_id}'"))?;
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
pub fn delete_checkpoint(
    app: tauri::AppHandle,
    course_id: String,
    checkpoint_id: String,
) -> Result<(), String> {
    if let Some(course_dir) = find_course_dir(&app, &course_id) {
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
    }
    Ok(())
}

// ── Markup annotations (annotations.json per course) ──────────────────────────
// The webview sends the already-merged full stroke array (LWW applied in JS),
// so these commands are a plain read/write of the JSON file.

#[tauri::command]
pub fn get_annotations(app: tauri::AppHandle, course_id: String) -> Result<Option<String>, String> {
    if let Some(course_dir) = find_course_dir(&app, &course_id) {
        let path = course_dir.join("annotations.json");
        if path.exists() {
            match std::fs::read_to_string(&path) {
                Ok(raw) => return Ok(Some(raw)),
                Err(e) => return Err(format!("Failed to read annotations: {e}")),
            }
        }
    }
    Ok(None)
}

#[tauri::command]
pub fn save_annotations(
    app: tauri::AppHandle,
    course_id: String,
    strokes_json: String,
) -> Result<(), String> {
    let course_dir = find_course_dir(&app, &course_id)
        .ok_or_else(|| format!("Could not resolve course dir for '{course_id}'"))?;
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
    let prompts_dir = get_prompts_dir(&app);
    let mut list = Vec::new();
    let mut seen_ids = std::collections::HashSet::new();
    if let Ok(entries) = std::fs::read_dir(&prompts_dir) {
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
    eprintln!("[Desktop-Native] list_prompts: found {} prompts in {:?}", list.len(), prompts_dir);
    Ok(list)
}

#[tauri::command]
pub fn save_prompt(app: tauri::AppHandle, id: String, content: String) -> Result<(), String> {
    let clean_id = id.trim().trim_end_matches(".md");
    if clean_id.is_empty() || clean_id.contains('/') || clean_id.contains('\\') || clean_id.contains("..") {
        return Err(format!("Invalid prompt ID: {}", clean_id));
    }
    let prompts_dir = get_prompts_dir(&app);
    std::fs::create_dir_all(&prompts_dir).map_err(|e| e.to_string())?;
    let path = prompts_dir.join(format!("{}.md", clean_id));
    std::fs::write(&path, content).map_err(|e| e.to_string())?;
    eprintln!("[Desktop-Native] save_prompt: saved {:?}", path);
    Ok(())
}

#[tauri::command]
pub fn delete_prompt(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let clean_id = id.trim().trim_end_matches(".md");
    if clean_id.is_empty() || clean_id.contains('/') || clean_id.contains('\\') || clean_id.contains("..") {
        return Err(format!("Invalid prompt ID: {}", clean_id));
    }
    let prompts_dir = get_prompts_dir(&app);
    let path = prompts_dir.join(format!("{}.md", clean_id));
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    eprintln!("[Desktop-Native] delete_prompt: deleted {:?}", path);
    Ok(())
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
}
