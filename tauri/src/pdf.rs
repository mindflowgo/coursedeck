use image::ImageEncoder;
use pdfium_render::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::Manager;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PdfPageInfo {
    pub page_index: u16,
    pub width: f32,
    pub height: f32,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PdfDocumentInfo {
    pub page_count: u16,
    pub pages: Vec<PdfPageInfo>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TextSpan {
    pub text: String,
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SearchHit {
    pub page_index: u16,
    pub rects: Vec<[f32; 4]>, // [x, y, w, h] in normalized 0.0-1.0
    pub snippet: String,
}

/// Maximum number of PDF documents kept open in the cache. Dropping a cached
/// document closes its handle inside pdfium, bounding memory use.
const MAX_OPEN_DOCUMENTS: usize = 4;

struct CachedDocument {
    /// (mtime millis, file size). A mismatch triggers a re-load, so replacing
    /// course.pdf on disk is picked up without an app restart.
    fingerprint: (u64, u64),
    last_used: Instant,
    doc: PdfDocument<'static>,
}

pub struct PdfEngine {
    pdfium: &'static Pdfium,
    documents: Mutex<HashMap<PathBuf, CachedDocument>>,
    text_cache: Mutex<HashMap<(PathBuf, u16, u64), Arc<Vec<TextSpan>>>>,
}

impl PdfEngine {
    pub fn new() -> Result<Self, String> {
        let bindings = resolve_pdfium_bindings()?;
        // Leak the single Pdfium instance so cached documents can borrow it
        // for 'static. The engine lives for the whole process, making this a
        // deliberate one-time allocation.
        let pdfium: &'static Pdfium = Box::leak(Box::new(Pdfium::new(bindings)));
        Ok(Self {
            pdfium,
            documents: Mutex::new(HashMap::new()),
            text_cache: Mutex::new(HashMap::new()),
        })
    }

    /// Runs `f` with the (cached) open document for `path`. The document is
    /// parsed once and reused across info/render/text/search calls — parsing
    /// an 80+ MB course book on every page render would otherwise dominate
    /// the response time. The cache lock is held for the whole operation,
    /// which also serializes all pdfium access (pdfium is not thread-safe).
    fn with_document<T>(
        &self,
        path: &Path,
        f: impl FnOnce(&mut PdfDocument<'static>) -> Result<T, String>,
    ) -> Result<T, String> {
        let fp = document_fingerprint(path)?;
        let mut documents = self
            .documents
            .lock()
            .map_err(|_| "PDF document cache lock poisoned".to_string())?;

        let needs_load = match documents.get(path) {
            Some(cached) => cached.fingerprint != fp,
            None => true,
        };

        if needs_load {
            documents.remove(path);
            let doc = self
                .pdfium
                .load_pdf_from_file(path, None)
                .map_err(|e| format!("Failed to open PDF at {path:?}: {e}"))?;
            documents.insert(
                path.to_path_buf(),
                CachedDocument {
                    fingerprint: fp,
                    last_used: Instant::now(),
                    doc,
                },
            );
            while documents.len() > MAX_OPEN_DOCUMENTS {
                let oldest = documents
                    .iter()
                    .min_by_key(|(_, cached)| cached.last_used)
                    .map(|(key, _)| key.clone());
                match oldest {
                    Some(key) => {
                        documents.remove(&key);
                    }
                    None => break,
                }
            }
            eprintln!("[PDFium] document cache: loaded {:?}", path);
        } else if let Some(cached) = documents.get_mut(path) {
            cached.last_used = Instant::now();
        }

        let cached = documents
            .get_mut(path)
            .ok_or_else(|| "PDF document cache miss".to_string())?;
        f(&mut cached.doc)
    }

    pub fn close_document(&self, path: &Path) -> Result<(), String> {
        let mut documents = self
            .documents
            .lock()
            .map_err(|_| "PDF document cache lock poisoned".to_string())?;
        if documents.remove(path).is_some() {
            eprintln!("[PDFium] document cache: closed and evicted {:?}", path);
        }
        if let Ok(mut text_cache) = self.text_cache.lock() {
            text_cache.retain(|(p, _, _), _| p != path);
        }
        Ok(())
    }

    pub fn get_info(&self, path: &Path) -> Result<PdfDocumentInfo, String> {
        self.with_document(path, |doc| {
            let pages = doc.pages();
            let page_count = pages.len();
            let mut page_infos = Vec::with_capacity(page_count as usize);

            for (idx, page) in pages.iter().enumerate() {
                page_infos.push(PdfPageInfo {
                    page_index: idx as u16,
                    width: page.width().value,
                    height: page.height().value,
                });
            }

            Ok(PdfDocumentInfo {
                page_count,
                pages: page_infos,
            })
        })
    }

    pub fn render_page_jpeg(
        &self,
        path: &Path,
        page_index: u16,
        scale: f32,
        quality: u8,
    ) -> Result<Vec<u8>, String> {
        // Render raster bitmap under PDFium lock
        let rgb_image = self.with_document(path, |doc| {
            let page = doc
                .pages()
                .get(page_index)
                .map_err(|e| format!("Page {page_index} out of bounds: {e}"))?;
            render_page_to_rgb_image(&page, scale)
        })?;

        // Pure Rust JPEG encoding runs outside the PDFium mutex lock, allowing parallel
        // compression across worker threads without blocking other page renders!
        encode_rgb_image_to_jpeg(&rgb_image, quality)
    }

    pub fn render_thumbnail_jpeg(
        &self,
        path: &Path,
        page_index: u16,
        target_width: f32,
    ) -> Result<Vec<u8>, String> {
        let rgb_image = self.with_document(path, |doc| {
            let page = doc
                .pages()
                .get(page_index)
                .map_err(|e| format!("Page {page_index} out of bounds: {e}"))?;
            let page_width = page.width().value;
            if page_width <= 0.0 {
                return Err(format!("Page {page_index} has invalid width").to_string());
            }
            // Scale relative to the page's real point width so thumbnails are
            // correctly sized for any page size (not just US Letter).
            let scale = (target_width / page_width).clamp(0.05, 4.0);
            render_page_to_rgb_image(&page, scale)
        })?;

        encode_rgb_image_to_jpeg(&rgb_image, 75)
    }

    pub fn get_page_text(&self, path: &Path, page_index: u16) -> Result<Arc<Vec<TextSpan>>, String> {
        let fp = document_fingerprint(path)?;
        let fp_key = fp.0 ^ fp.1;
        let cache_key = (path.to_path_buf(), page_index, fp_key);

        if let Ok(cache) = self.text_cache.lock() {
            if let Some(spans) = cache.get(&cache_key) {
                return Ok(spans.clone());
            }
        }

        let spans = self.with_document(path, |doc| {
            let page = doc
                .pages()
                .get(page_index)
                .map_err(|e| format!("Page {page_index} not found: {e}"))?;

            let text = page.text().map_err(|e| e.to_string())?;
            let page_w = page.width().value;
            let page_h = page.height().value;

            if page_w <= 0.0 || page_h <= 0.0 {
                return Ok(Vec::new());
            }

            let mut spans = Vec::new();
            for segment in text.segments().iter() {
                let seg_text = segment.text();
                if seg_text.trim().is_empty() {
                    continue;
                }
                let rect = segment.bounds();
                let x = (rect.left().value / page_w).clamp(0.0, 1.0);
                let y = ((page_h - rect.top().value) / page_h).clamp(0.0, 1.0);
                let w = ((rect.right().value - rect.left().value) / page_w).clamp(0.0, 1.0);
                let h = ((rect.top().value - rect.bottom().value) / page_h).clamp(0.0, 1.0);

                spans.push(TextSpan {
                    text: seg_text,
                    x,
                    y,
                    w,
                    h,
                });
            }

            Ok(spans)
        })?;

        let arc_spans = Arc::new(spans);
        if let Ok(mut cache) = self.text_cache.lock() {
            cache.insert(cache_key, arc_spans.clone());
        }

        Ok(arc_spans)
    }

    pub fn search(
        &self,
        path: &Path,
        query: &str,
        match_case: bool,
        max_results: usize,
    ) -> Result<Vec<SearchHit>, String> {
        if query.trim().is_empty() {
            return Ok(Vec::new());
        }

        let page_count = self.with_document(path, |doc| Ok(doc.pages().len()))?;
        let mut hits = Vec::new();

        // Search in chunks of 4 pages, acquiring and releasing the mutex between chunks.
        // This yields the lock so render requests can interleave immediately!
        let chunk_size: u16 = 4;
        let mut start_page: u16 = 0;

        while start_page < page_count {
            let end_page = (start_page + chunk_size).min(page_count);

            let chunk_hits = self.with_document(path, |doc| {
                let mut options = PdfSearchOptions::new();
                if match_case {
                    options = options.match_case(true);
                }

                let mut sub_hits = Vec::new();
                let pages = doc.pages();

                for page_idx in start_page..end_page {
                    if let Ok(page) = pages.get(page_idx) {
                        if let Ok(text) = page.text() {
                            if let Ok(search) = text.search(query, &options) {
                                let page_w = page.width().value;
                                let page_h = page.height().value;

                                for match_segments in search.iter(PdfSearchDirection::SearchForward) {
                                    let mut rects = Vec::new();
                                    let mut snippet = String::new();

                                    for seg in match_segments.iter() {
                                        snippet.push_str(&seg.text());
                                        let rect = seg.bounds();
                                        if page_w > 0.0 && page_h > 0.0 {
                                            let x = (rect.left().value / page_w).clamp(0.0, 1.0);
                                            let y = ((page_h - rect.top().value) / page_h).clamp(0.0, 1.0);
                                            let w = ((rect.right().value - rect.left().value) / page_w)
                                                .clamp(0.0, 1.0);
                                            let h = ((rect.top().value - rect.bottom().value) / page_h)
                                                .clamp(0.0, 1.0);
                                            rects.push([x, y, w, h]);
                                        }
                                    }

                                    if !rects.is_empty() {
                                        sub_hits.push(SearchHit {
                                            page_index: page_idx,
                                            rects,
                                            snippet,
                                        });
                                    }
                                }
                            }
                        }
                    }
                }
                Ok(sub_hits)
            })?;

            hits.extend(chunk_hits);
            if hits.len() >= max_results {
                hits.truncate(max_results);
                break;
            }

            start_page = end_page;
            // Short yield so any pending render thread grabs the lock
            std::thread::yield_now();
        }

        Ok(hits)
    }
}

fn document_fingerprint(path: &Path) -> Result<(u64, u64), String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("Cannot stat {path:?}: {e}"))?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Ok((mtime, meta.len()))
}

fn render_page_to_rgb_image(page: &PdfPage, scale: f32) -> Result<image::RgbImage, String> {
    // 72 DPI is 1.0 point scale in PDFium
    let target_w = ((page.width().value * scale).round() as i32).max(1);
    let target_h = ((page.height().value * scale).round() as i32).max(1);

    let render_config = PdfRenderConfig::new()
        .set_target_width(target_w)
        .set_target_height(target_h)
        .render_form_data(true);

    let bitmap = page
        .render_with_config(&render_config)
        .map_err(|e| format!("Render failed: {e}"))?;

    let dynamic_image = bitmap.as_image();
    // JPEG has no alpha channel; the encoder only accepts RGB input.
    Ok(dynamic_image.to_rgb8())
}

fn encode_rgb_image_to_jpeg(rgb_image: &image::RgbImage, quality: u8) -> Result<Vec<u8>, String> {
    let mut jpeg_bytes = Vec::new();
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg_bytes, quality);
    encoder
        .write_image(
            rgb_image.as_raw(),
            rgb_image.width(),
            rgb_image.height(),
            image::ExtendedColorType::Rgb8,
        )
        .map_err(|e| format!("JPEG encoding failed: {e}"))?;

    Ok(jpeg_bytes)
}

fn resolve_pdfium_bindings() -> Result<Box<dyn PdfiumLibraryBindings>, String> {
    if let Ok(custom_path) = std::env::var("PDFIUM_PATH") {
        let p = PathBuf::from(custom_path);
        if p.exists() {
            if let Ok(b) = Pdfium::bind_to_library(&p) {
                return Ok(b);
            }
        }
    }

    #[cfg(target_os = "ios")]
    {
        if let Ok(exe_path) = std::env::current_exe() {
            if let Some(bundle_dir) = exe_path.parent() {
                let fw_path = bundle_dir.join("Frameworks/pdfium.framework/pdfium");
                if fw_path.exists() {
                    if let Ok(b) = Pdfium::bind_to_library(&fw_path) {
                        return Ok(b);
                    }
                }
            }
        }
    }

    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    {
        let mut candidates = Vec::new();

        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                candidates.push(dir.join("libpdfium.dylib"));
                candidates.push(dir.join("bin/libpdfium.dylib"));
                candidates.push(dir.join("../Resources/bin/libpdfium.dylib"));
                candidates.push(dir.join("../Resources/libpdfium.dylib"));
                candidates.push(dir.join("pdfium.dll"));
                candidates.push(dir.join("bin/pdfium.dll"));
                candidates.push(dir.join("libpdfium.so"));
            }
        }

        if let Ok(cwd) = std::env::current_dir() {
            candidates.push(cwd.join("libpdfium.dylib"));
            candidates.push(cwd.join("bin/libpdfium.dylib"));
            candidates.push(cwd.join("tauri/libpdfium.dylib"));
            candidates.push(cwd.join("tauri/bin/libpdfium.dylib"));
            candidates.push(cwd.join("../tauri/bin/libpdfium.dylib"));
            candidates.push(cwd.join("pdfium.dll"));
            candidates.push(cwd.join("bin/pdfium.dll"));
            candidates.push(cwd.join("tauri/bin/pdfium.dll"));
            candidates.push(cwd.join("libpdfium.so"));
        }

        for path in candidates {
            if path.exists() {
                if let Ok(bindings) = Pdfium::bind_to_library(&path) {
                    eprintln!("[PDFium] Loaded native library from {:?}", path);
                    return Ok(bindings);
                }
            }
        }
    }

    Pdfium::bind_to_system_library()
        .map_err(|e| format!("Failed to bind to system PDFium library: {e}"))
}

fn find_course_dir_any(app: &tauri::AppHandle, course_id: &str) -> Option<PathBuf> {
    let lower_id = course_id.to_lowercase();

    // 1. Check tauri app_data_dir/courses/{course_id}
    if let Ok(app_data) = app.path().app_data_dir() {
        for candidate in &[
            app_data.join("courses").join(&lower_id),
            app_data.join("data/courses").join(&lower_id),
        ] {
            if candidate.exists() {
                return Some(candidate.clone());
            }
        }

        // 2. Honor a custom data_dir configured in the backend settings.json
        //    (same resolution the Bun backend uses) so the packaged app finds
        //    courses stored outside the app-support directory.
        if let Ok(settings) = std::fs::read_to_string(app_data.join("settings.json")) {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&settings) {
                if let Some(dir) = value.get("data_dir").and_then(|d| d.as_str()) {
                    let candidate = PathBuf::from(dir).join("courses").join(&lower_id);
                    if candidate.exists() {
                        return Some(candidate);
                    }
                }
            }
        }
    }

    // 3. Check current working dir data/courses/{course_id}
    if let Ok(cwd) = std::env::current_dir() {
        for base in &[
            cwd.join("data").join("courses"),
            cwd.join("..").join("data").join("courses"),
            cwd.join("courses"),
        ] {
            let candidate = base.join(&lower_id);
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }

    // 4. Check DATA_DIR env
    if let Ok(data_env) = std::env::var("DATA_DIR") {
        let candidate = PathBuf::from(data_env).join("courses").join(&lower_id);
        if candidate.exists() {
            return Some(candidate);
        }
    }

    None
}

pub fn resolve_pdf_path(app: &tauri::AppHandle, path_or_url: &str) -> PathBuf {
    let clean = path_or_url.trim();

    // Check if it's an API asset URL: /api/courses/{course_id}/assets/{asset_subpath}
    if let Some(stripped) = clean
        .strip_prefix("/api/courses/")
        .or_else(|| clean.strip_prefix("api/courses/"))
    {
        if let Some((course_id, rest)) = stripped.split_once('/') {
            if let Some(asset_rel) = rest.strip_prefix("assets/") {
                if let Some(course_dir) = find_course_dir_any(app, course_id) {
                    let direct_path = course_dir.join("assets").join(asset_rel);
                    if direct_path.exists() {
                        return direct_path;
                    }
                    let alt_path = course_dir.join(asset_rel);
                    if alt_path.exists() {
                        return alt_path;
                    }
                }
            }
        }
    }

    let p = PathBuf::from(clean);
    if p.is_absolute() && p.exists() {
        return p;
    }

    if let Ok(cwd) = std::env::current_dir() {
        let relative = cwd.join(&p);
        if relative.exists() {
            return relative;
        }
    }

    p
}

pub struct PdfEngineState(pub Result<Arc<PdfEngine>, String>);

fn engine_from_state(state: &tauri::State<'_, PdfEngineState>) -> Result<Arc<PdfEngine>, String> {
    state.0.as_ref().map_err(|e| e.clone()).cloned()
}

// ── Tauri IPC Commands with Zero-Copy / Raw Bytes Support ─────────────────────
//
// All commands are async and offload the pdfium work onto the blocking thread
// pool: synchronous commands execute on the main thread on macOS, where a
// 100ms+ page render would freeze the whole native window.

#[tauri::command]
pub async fn pdf_get_info(
    app: tauri::AppHandle,
    state: tauri::State<'_, PdfEngineState>,
    path: String,
) -> Result<PdfDocumentInfo, String> {
    let engine = engine_from_state(&state)?;
    let resolved = resolve_pdf_path(&app, &path);
    tauri::async_runtime::spawn_blocking(move || engine.get_info(&resolved))
        .await
        .map_err(|e| format!("PDF info task failed: {e}"))?
}

#[tauri::command]
pub async fn pdf_render_page(
    app: tauri::AppHandle,
    state: tauri::State<'_, PdfEngineState>,
    path: String,
    page_index: u16,
    scale: Option<f32>,
    quality: Option<u8>,
) -> Result<tauri::ipc::Response, String> {
    let engine = engine_from_state(&state)?;
    let resolved = resolve_pdf_path(&app, &path);
    let scale_factor = scale.unwrap_or(1.5).clamp(0.2, 4.0);
    let q = quality.unwrap_or(85).clamp(20, 100);

    tauri::async_runtime::spawn_blocking(move || {
        let bytes = engine.render_page_jpeg(&resolved, page_index, scale_factor, q)?;
        Ok(tauri::ipc::Response::new(bytes))
    })
    .await
    .map_err(|e| format!("PDF render task failed: {e}"))?
}

#[tauri::command]
pub async fn pdf_render_thumbnail(
    app: tauri::AppHandle,
    state: tauri::State<'_, PdfEngineState>,
    path: String,
    page_index: u16,
    width: Option<f32>,
) -> Result<tauri::ipc::Response, String> {
    let engine = engine_from_state(&state)?;
    let resolved = resolve_pdf_path(&app, &path);
    let target_width = width.unwrap_or(140.0).clamp(50.0, 300.0);

    tauri::async_runtime::spawn_blocking(move || {
        let bytes = engine.render_thumbnail_jpeg(&resolved, page_index, target_width)?;
        Ok(tauri::ipc::Response::new(bytes))
    })
    .await
    .map_err(|e| format!("PDF thumbnail task failed: {e}"))?
}

#[tauri::command]
pub async fn pdf_get_page_text(
    app: tauri::AppHandle,
    state: tauri::State<'_, PdfEngineState>,
    path: String,
    page_index: u16,
) -> Result<Arc<Vec<TextSpan>>, String> {
    let engine = engine_from_state(&state)?;
    let resolved = resolve_pdf_path(&app, &path);
    tauri::async_runtime::spawn_blocking(move || engine.get_page_text(&resolved, page_index))
        .await
        .map_err(|e| format!("PDF text task failed: {e}"))?
}

#[tauri::command]
pub async fn pdf_search(
    app: tauri::AppHandle,
    state: tauri::State<'_, PdfEngineState>,
    path: String,
    query: String,
    match_case: Option<bool>,
    max_results: Option<usize>,
) -> Result<Vec<SearchHit>, String> {
    let engine = engine_from_state(&state)?;
    let resolved = resolve_pdf_path(&app, &path);
    tauri::async_runtime::spawn_blocking(move || {
        engine.search(
            &resolved,
            &query,
            match_case.unwrap_or(false),
            max_results.unwrap_or(200),
        )
    })
    .await
    .map_err(|e| format!("PDF search task failed: {e}"))?
}

#[tauri::command]
pub async fn pdf_close_document(
    app: tauri::AppHandle,
    state: tauri::State<'_, PdfEngineState>,
    path: String,
) -> Result<(), String> {
    let engine = engine_from_state(&state)?;
    let resolved = resolve_pdf_path(&app, &path);
    tauri::async_runtime::spawn_blocking(move || engine.close_document(&resolved))
        .await
        .map_err(|e| format!("PDF close task failed: {e}"))?
}
