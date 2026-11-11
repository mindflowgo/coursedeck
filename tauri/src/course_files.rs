// Course-file operations shared byte-for-byte by the desktop and iPad apps:
// lesson bundles, course docs, cached manifests, checkpoints, annotations,
// prompts and groups. Every function is parameterized by the caller-resolved
// root (desktop: settings/data_dir; iPad: Documents) so the apps stay thin
// #[tauri::command] wrappers. JSON sidecars are written atomically.

use crate::fs_util::write_file_atomic;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LessonBundleResponse {
    pub course_id: String,
    pub lesson_id: String,
    pub lesson: String,
    pub tabs: HashMap<String, String>,
    pub format: String,
    pub has_companion: bool,
}

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
pub struct PromptItem {
    pub id: String,
    pub title: String,
    pub filename: String,
    pub content: String,
}

pub fn course_dir(courses_root: &Path, course_id: &str) -> PathBuf {
    courses_root.join(course_id.to_lowercase())
}

/// Normalizes a lesson id like `1-2` or `1-10` to zero-padded `01-02` / `01-10`,
/// leaving non-lesson ids (`course.schedule`, `01.unit`) untouched.
pub fn normalize_lesson_id(s: &str) -> String {
    let s = s.trim().to_lowercase();
    if let Some(pos) = s.find('-') {
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
                    return format!("{:02}-{:02}{}", u, l, suffix);
                }
            }
        }
    }
    s
}

/// All `.md` files of one lesson: `<lesson>.lesson.md` becomes `lesson`, every
/// other `<lesson>.<tab>.md` becomes a tab. Matches raw or normalized ids.
pub fn lesson_bundle(
    courses_root: &Path,
    course_id: &str,
    lesson_id: &str,
) -> Result<LessonBundleResponse, String> {
    let course_dir = course_dir(courses_root, course_id);
    if !course_dir.exists() {
        return Ok(LessonBundleResponse {
            course_id: course_id.to_string(),
            lesson_id: lesson_id.to_string(),
            lesson: String::new(),
            tabs: HashMap::new(),
            format: "markdown".to_string(),
            has_companion: false,
        });
    }

    let target_norm = normalize_lesson_id(lesson_id);
    let target_raw = lesson_id.trim().to_lowercase();

    // 1. Detect primary format
    let html_path = course_dir.join(format!("{}.lesson.html", target_norm));
    let pdf_path  = course_dir.join(format!("{}.lesson.pdf", target_norm));
    let md_path   = course_dir.join(format!("{}.lesson.md", target_norm));
    let comp_path = course_dir.join(format!("{}.lesson.companion.md", target_norm));

    let format = if html_path.exists() {
        "html"
    } else if pdf_path.exists() {
        "pdf"
    } else {
        "markdown"
    };

    // 2. Load companion or lesson markdown
    let lesson_content = if format != "markdown" {
        std::fs::read_to_string(&comp_path).unwrap_or_default()
    } else {
        std::fs::read_to_string(&md_path).unwrap_or_default()
    };

    let has_companion = format != "markdown"
        && comp_path.exists()
        && !lesson_content.trim().is_empty();

    // 3. Collect other tab files; skip companion files
    let mut tabs = HashMap::new();
    let mut matched_files = Vec::new();

    let entries = std::fs::read_dir(&course_dir)
        .map_err(|e| format!("Failed to read course dir {course_dir:?}: {e}"))?;

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let file_name = entry.file_name().to_string_lossy().to_string();
        // Skip companion files
        if file_name.ends_with(".companion.md") {
            continue;
        }
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
                if file_tab == "lesson" {
                    continue;
                }
                if let Ok(content) = std::fs::read_to_string(&path) {
                    matched_files.push(file_name.clone());
                    tabs.insert(file_tab.to_string(), content);
                }
            }
        }
    }

    eprintln!(
        "[core] lesson_bundle: course={} lesson_id={} (norm={}) format={} matched {} tabs, has_lesson={}, tabs={:?}",
        course_id,
        lesson_id,
        target_norm,
        format,
        matched_files.len(),
        !lesson_content.is_empty(),
        tabs.keys().collect::<Vec<_>>()
    );

    Ok(LessonBundleResponse {
        course_id: course_id.to_string(),
        lesson_id: lesson_id.to_string(),
        lesson: lesson_content,
        tabs,
        format: format.to_string(),
        has_companion,
    })
}

pub fn read_course_doc(
    courses_root: &Path,
    course_id: &str,
    filename: &str,
) -> Result<Option<String>, String> {
    let file_path = course_dir(courses_root, course_id).join(filename);
    if file_path.exists() {
        let content = std::fs::read_to_string(&file_path)
            .map_err(|e| format!("Failed to read {file_path:?}: {e}"))?;
        return Ok(Some(content));
    }
    Ok(None)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationSource {
    pub source_file: String,
    pub content: String,
    pub renderer: String,
}

static ANNOTATION_SOURCE_WRITE: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn annotation_source_path(root: &Path, course_id: &str, file: &str) -> Result<PathBuf, String> {
    if course_id.is_empty() || !course_id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_') {
        return Err("Invalid course identifier".into());
    }
    if file.is_empty() || !file.as_bytes()[0].is_ascii_alphanumeric()
        || file.split('.').any(|part| part.is_empty() || !part.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_'))
        || !(file.ends_with(".md") || file.ends_with(".html")) {
        return Err("Invalid annotation source filename".into());
    }
    let dir = course_dir(root, course_id);
    let canonical_root = root.canonicalize().map_err(|e| e.to_string())?;
    let canonical_dir = dir.canonicalize().map_err(|e| e.to_string())?;
    if canonical_dir.parent() != Some(canonical_root.as_path()) {
        return Err("Annotation course escapes source directory".into());
    }
    let source = dir.join(file);
    if source.exists() {
        let canonical_source = source.canonicalize().map_err(|e| e.to_string())?;
        if canonical_source.parent() != Some(canonical_dir.as_path()) {
            return Err("Annotation source escapes course directory".into());
        }
    }
    Ok(source)
}

pub fn read_annotation_source(root: &Path, course_id: &str, file: &str, renderer: &str) -> Result<Option<AnnotationSource>, String> {
    // Validate the requested name before deriving an original or companion.
    annotation_source_path(root, course_id, file)?;
    let stem = file.strip_suffix(".lesson.md").or_else(|| file.strip_suffix(".lesson.html"));
    let source_file = match renderer {
        "html" => format!("{}.lesson.html", stem.ok_or("HTML annotations require a lesson HTML source")?),
        "markdown" => {
            if let Some(stem) = stem {
                let dir = course_dir(root, course_id);
                if dir.join(format!("{stem}.lesson.html")).exists() || dir.join(format!("{stem}.lesson.pdf")).exists() {
                    format!("{stem}.lesson.companion.md")
                } else {
                    format!("{stem}.lesson.md")
                }
            } else if file.ends_with(".md") { file.to_string() }
            else { return Err("Markdown annotations require a Markdown source".into()); }
        },
        _ => return Err("Invalid annotation renderer".into()),
    };
    let path = annotation_source_path(root, course_id, &source_file)?;
    if !path.exists() { return Ok(None); }
    let content = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    Ok(Some(AnnotationSource { source_file, content, renderer: renderer.to_string() }))
}

/// Compare-and-swap prevents a lazy migration from overwriting an intervening edit.
pub fn save_annotation_source(root: &Path, course_id: &str, source_file: &str, expected_content: &str, content: &str) -> Result<(), String> {
    let _guard = ANNOTATION_SOURCE_WRITE.lock().map_err(|e| e.to_string())?;
    let path = annotation_source_path(root, course_id, source_file)?;
    let original = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    if original != expected_content { return Err("Annotation source changed; retry the annotation".into()); }
    if original != content { write_file_atomic(&path, content.as_bytes())?; }
    Ok(())
}

#[cfg(test)]
mod annotation_source_tests {
    use super::*;

    #[test]
    fn annotation_source_is_file_local_and_rejects_stale_writes() {
        let unique = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!("coursedeck-anchor-test-{}-{unique}", std::process::id()));
        let dir = root.join("example");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("01.01.lesson.html"), "<p>Original</p>").unwrap();
        std::fs::write(dir.join("01.01.lesson.companion.md"), "Companion").unwrap();
        let html = read_annotation_source(&root, "EXAMPLE", "01.01.lesson.md", "html").unwrap().unwrap();
        assert_eq!(html.source_file, "01.01.lesson.html");
        let markdown = read_annotation_source(&root, "example", "01.01.lesson.md", "markdown").unwrap().unwrap();
        assert_eq!(markdown.source_file, "01.01.lesson.companion.md");
        save_annotation_source(&root, "example", &html.source_file, &html.content, "<p data-anchor-id=\"keep\">Original</p>").unwrap();
        assert_eq!(std::fs::read_to_string(dir.join(&markdown.source_file)).unwrap(), "Companion");
        assert!(save_annotation_source(&root, "example", &html.source_file, &html.content, "stale").is_err());
        assert!(read_annotation_source(&root, "../example", "01.01.lesson.md", "html").is_err());
        assert!(read_annotation_source(&root, "example", "../outside.md", "markdown").is_err());
        assert!(read_annotation_source(&root, "example", "C:\\outside.md", "markdown").is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}

pub fn save_course_doc(
    courses_root: &Path,
    course_id: &str,
    filename: &str,
    content: &str,
) -> Result<(), String> {
    let course_dir = course_dir(courses_root, course_id);
    std::fs::create_dir_all(&course_dir)
        .map_err(|e| format!("Failed to create course dir {course_dir:?}: {e}"))?;
    std::fs::write(&course_dir.join(filename), content)
        .map_err(|e| format!("Failed to write {filename:?} in {course_dir:?}: {e}"))
}

/// Deletes a course doc, also probing the normalized-lesson-id spelling of
/// the filename (e.g. `1-1.tab.md` stored as `01-01.tab.md`).
pub fn delete_course_doc(
    courses_root: &Path,
    course_id: &str,
    filename: &str,
) -> Result<bool, String> {
    let course_dir = course_dir(courses_root, course_id);
    if !course_dir.exists() {
        return Ok(false);
    }

    let direct_path = course_dir.join(filename);
    if direct_path.exists() {
        std::fs::remove_file(&direct_path)
            .map_err(|e| format!("Failed to delete {direct_path:?}: {e}"))?;
        return Ok(true);
    }

    if let Some(last_dot) = filename[..filename.len().saturating_sub(3)].rfind('.') {
        let file_lesson = &filename[..last_dot];
        let file_tab = &filename[last_dot + 1..filename.len().saturating_sub(3)];
        let norm_lesson = normalize_lesson_id(file_lesson);
        let norm_filename = format!("{norm_lesson}.{file_tab}.md");
        let norm_path = course_dir.join(&norm_filename);
        if norm_path.exists() {
            std::fs::remove_file(&norm_path)
                .map_err(|e| format!("Failed to delete {norm_path:?}: {e}"))?;
            return Ok(true);
        }
    }
    Ok(false)
}

/// Every course manifest under the root, as raw JSON values.
pub fn list_cached_courses(courses_root: &Path) -> Vec<serde_json::Value> {
    let mut courses = Vec::new();
    if let Ok(entries) = std::fs::read_dir(courses_root) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let manifest_path = path.join(".manifest.json");
                if manifest_path.exists() {
                    if let Ok(raw) = std::fs::read_to_string(&manifest_path) {
                        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&raw) {
                            courses.push(val);
                        }
                    }
                }
            }
        }
    }
    courses
}

pub fn get_cached_course(
    courses_root: &Path,
    course_id: &str,
) -> Result<Option<serde_json::Value>, String> {
    let manifest_path = course_dir(courses_root, course_id).join(".manifest.json");
    if manifest_path.exists() {
        let raw = std::fs::read_to_string(&manifest_path)
            .map_err(|e| format!("Failed to read manifest {manifest_path:?}: {e}"))?;
        let val = serde_json::from_str(&raw)
            .map_err(|e| format!("Failed to parse manifest: {e}"))?;
        return Ok(Some(val));
    }
    Ok(None)
}

pub fn delete_course(courses_root: &Path, course_id: &str) -> Result<bool, String> {
    let course_dir = course_dir(courses_root, course_id);
    if course_dir.exists() {
        std::fs::remove_dir_all(&course_dir)
            .map_err(|e| format!("Failed to delete course directory {course_dir:?}: {e}"))?;
        return Ok(true);
    }
    Ok(false)
}

// ── Checkpoints (.checkpoints.json per course) ────────────────────────────────

pub fn get_cached_checkpoints(courses_root: &Path, course_id: &str) -> Vec<serde_json::Value> {
    let cp_path = course_dir(courses_root, course_id).join(".checkpoints.json");
    if cp_path.exists() {
        let raw = std::fs::read_to_string(&cp_path).unwrap_or_default();
        let val =
            serde_json::from_str(&raw).unwrap_or_else(|_| serde_json::Value::Array(Vec::new()));
        if let serde_json::Value::Array(arr) = val {
            return arr;
        }
    }
    Vec::new()
}

/// Upserts by checkpoint id and writes the list back atomically.
pub fn save_checkpoint(
    courses_root: &Path,
    course_id: &str,
    checkpoint: serde_json::Value,
) -> Result<(), String> {
    let course_dir = course_dir(courses_root, course_id);
    std::fs::create_dir_all(&course_dir)
        .map_err(|e| format!("Failed to create dir {course_dir:?}: {e}"))?;
    let cp_path = course_dir.join(".checkpoints.json");
    let mut list: Vec<serde_json::Value> = if cp_path.exists() {
        let raw = std::fs::read_to_string(&cp_path).unwrap_or_default();
        serde_json::from_str(&raw).unwrap_or_default()
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
    write_file_atomic(&cp_path, json.as_bytes())
        .map_err(|e| format!("Failed to write checkpoints: {e}"))
}

pub fn delete_checkpoint(
    courses_root: &Path,
    course_id: &str,
    checkpoint_id: &str,
) -> Result<(), String> {
    let cp_path = course_dir(courses_root, course_id).join(".checkpoints.json");
    if cp_path.exists() {
        let raw = std::fs::read_to_string(&cp_path).unwrap_or_default();
        if let Ok(list) = serde_json::from_str::<Vec<serde_json::Value>>(&raw) {
            let filtered: Vec<_> = list
                .into_iter()
                .filter(|c| c.get("id").and_then(|v| v.as_str()) != Some(checkpoint_id))
                .collect();
            let json = serde_json::to_string_pretty(&filtered)
                .map_err(|e| format!("Serialization error: {e}"))?;
            write_file_atomic(&cp_path, json.as_bytes())
                .map_err(|e| format!("Failed to write checkpoints: {e}"))?;
        }
    }
    Ok(())
}

// ── Markup annotations (.annotations.json per course) ─────────────────────────
// The webview sends the already-merged full stroke array (LWW applied in JS),
// so this is a plain (atomic) read/write of the JSON file.

pub fn get_annotations(courses_root: &Path, course_id: &str) -> Result<Option<String>, String> {
    let path = course_dir(courses_root, course_id).join(".annotations.json");
    if path.exists() {
        let raw = std::fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read annotations: {e}"))?;
        return Ok(Some(raw));
    }
    Ok(None)
}

pub fn save_annotations(
    courses_root: &Path,
    course_id: &str,
    strokes_json: &str,
) -> Result<(), String> {
    let course_dir = course_dir(courses_root, course_id);
    std::fs::create_dir_all(&course_dir)
        .map_err(|e| format!("Failed to create dir {course_dir:?}: {e}"))?;
    // Validate it is a JSON array before writing
    let parsed: Vec<serde_json::Value> = serde_json::from_str(strokes_json)
        .map_err(|e| format!("Invalid annotations JSON: {e}"))?;
    let json =
        serde_json::to_string_pretty(&parsed).map_err(|e| format!("Serialization error: {e}"))?;
    write_file_atomic(&course_dir.join(".annotations.json"), json.as_bytes())
        .map_err(|e| format!("Failed to write annotations: {e}"))
}

// ── Prompts (plain .md files; caller decides the directory) ───────────────────

pub fn list_prompts(prompts_dir: &Path) -> Vec<PromptItem> {
    let mut list = Vec::new();
    let mut seen_ids = std::collections::HashSet::new();
    if let Ok(entries) = std::fs::read_dir(prompts_dir) {
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
    list
}

fn assert_prompt_id(id: &str) -> Result<String, String> {
    let clean_id = id.trim().trim_end_matches(".md");
    if clean_id.is_empty() || clean_id.contains('/') || clean_id.contains('\\') || clean_id.contains("..") {
        return Err(format!("Invalid prompt ID: {clean_id}"));
    }
    Ok(clean_id.to_string())
}

pub fn save_prompt(prompts_dir: &Path, id: &str, content: &str) -> Result<String, String> {
    let clean_id = assert_prompt_id(id)?;
    std::fs::create_dir_all(prompts_dir).map_err(|e| e.to_string())?;
    let path = prompts_dir.join(format!("{clean_id}.md"));
    std::fs::write(&path, content).map_err(|e| e.to_string())?;
    Ok(clean_id)
}

pub fn delete_prompt(prompts_dir: &Path, id: &str) -> Result<(), String> {
    let clean_id = assert_prompt_id(id)?;
    let path = prompts_dir.join(format!("{clean_id}.md"));
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ── Groups (groups.json in the data root beside courses/) ─────────────────────

pub fn read_groups_json(data_dir: &Path) -> Result<String, String> {
    let path = data_dir.join("groups.json");
    if path.exists() {
        std::fs::read_to_string(&path).map_err(|e| e.to_string())
    } else {
        Ok("[]".to_string())
    }
}

pub fn write_groups_json(data_dir: &Path, content: &str) -> Result<(), String> {
    std::fs::create_dir_all(data_dir).map_err(|e| e.to_string())?;
    write_file_atomic(&data_dir.join("groups.json"), content.as_bytes())
}
