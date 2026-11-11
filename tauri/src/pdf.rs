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

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct CompanionResult {
    pub companion_path: Option<String>,
    pub markdown: String,
    pub page_count: u32,
    pub pdf_type: String,
    pub used_ocr: bool,
    pub pages_needing_ocr: Vec<u32>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct CompanionProgress {
    pub current_page: usize,
    pub total_pages: usize,
    pub stage: String,
    pub is_ocr: bool,
    pub message: String,
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

            // page_sizes() reads each MediaBox via FPDF_GetPageSizeByIndexF.
            // Iterating pages instead (FPDF_LoadPage + close per page) made
            // get_info latency scale with page count on large course books.
            let sizes = pages
                .page_sizes()
                .map_err(|e| format!("Failed to read page dimensions: {e}"))?;
            let page_infos = sizes
                .iter()
                .enumerate()
                .map(|(idx, size)| PdfPageInfo {
                    page_index: idx as u16,
                    width: size.width().value,
                    height: size.height().value,
                })
                .collect::<Vec<_>>();

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

    pub fn render_page_png(
        &self,
        path: &Path,
        page_index: u16,
        scale: f32,
    ) -> Result<Vec<u8>, String> {
        let rgb_image = self.with_document(path, |doc| {
            let page = doc
                .pages()
                .get(page_index)
                .map_err(|e| format!("Page {page_index} out of bounds: {e}"))?;
            render_page_to_rgb_image(&page, scale)
        })?;

        let mut png_bytes = Vec::new();
        image::DynamicImage::ImageRgb8(rgb_image)
            .write_to(&mut std::io::Cursor::new(&mut png_bytes), image::ImageFormat::Png)
            .map_err(|e| format!("PNG encoding failed: {e}"))?;
        Ok(png_bytes)
    }

    pub fn render_page_png_from_bytes(
        &self,
        pdf_bytes: &[u8],
        page_index: u16,
        scale: f32,
    ) -> Result<Vec<u8>, String> {
        let doc = self
            .pdfium
            .load_pdf_from_byte_slice(pdf_bytes, None)
            .map_err(|e| format!("Failed to load PDF from bytes: {e}"))?;
        let page = doc
            .pages()
            .get(page_index)
            .map_err(|e| format!("Page {page_index} out of bounds: {e}"))?;
        let rgb_image = render_page_to_rgb_image(&page, scale)?;

        let mut png_bytes = Vec::new();
        image::DynamicImage::ImageRgb8(rgb_image)
            .write_to(&mut std::io::Cursor::new(&mut png_bytes), image::ImageFormat::Png)
            .map_err(|e| format!("PNG encoding failed: {e}"))?;
        Ok(png_bytes)
    }

    pub fn extract_companion_markdown<F>(
        &self,
        pdf_bytes: &[u8],
        pdf_path: Option<&Path>,
        mut on_progress: F,
    ) -> Result<CompanionResult, String>
    where
        F: FnMut(CompanionProgress),
    {
        on_progress(CompanionProgress {
            current_page: 0,
            total_pages: 0,
            stage: "inspecting".to_string(),
            is_ocr: false,
            message: "Analyzing PDF structure...".to_string(),
        });

        let extraction = pdf_inspector::extract_pages_markdown_mem(pdf_bytes, None)
            .map_err(|e| format!("pdf-inspector extraction failed: {e}"))?;

        let detection = pdf_inspector::detect_pdf_type_mem(pdf_bytes);
        let pdf_type_str = match detection {
            Ok(d) => format!("{:?}", d.pdf_type),
            Err(_) => "Unknown".to_string(),
        };
        let mut used_ocr = false;
        let pages_needing_ocr = extraction.pages_needing_ocr.clone();
        let ocr_supported = crate::ocr::is_ocr_supported();
        let total_pages = extraction.pages.len();

        let mut page_markdowns: Vec<(u32, String)> = Vec::with_capacity(total_pages);

        for page in extraction.pages {
            let page_num_1indexed = page.page + 1;
            let mut md = page.markdown.trim().to_string();
            let needs_ocr = page.needs_ocr || pages_needing_ocr.contains(&page_num_1indexed);

            if (md.is_empty() || needs_ocr) && ocr_supported {
                on_progress(CompanionProgress {
                    current_page: page_num_1indexed as usize,
                    total_pages,
                    stage: "ocr".to_string(),
                    is_ocr: true,
                    message: format!("Processing page {}/{} (OCR)...", page_num_1indexed, total_pages),
                });

                let rendered_png = if let Some(path) = pdf_path {
                    self.render_page_png(path, page.page as u16, 2.5)
                } else {
                    self.render_page_png_from_bytes(pdf_bytes, page.page as u16, 2.5)
                };

                if let Ok(png_bytes) = rendered_png {
                    if let Ok(ocr_text) = crate::ocr::run_native_ocr(&png_bytes) {
                        let trimmed = ocr_text.trim();
                        if !trimmed.is_empty() {
                            md = trimmed.to_string();
                            used_ocr = true;
                        }
                    }
                }
            } else {
                on_progress(CompanionProgress {
                    current_page: page_num_1indexed as usize,
                    total_pages,
                    stage: "extracting".to_string(),
                    is_ocr: false,
                    message: format!("Extracting page {}/{}...", page_num_1indexed, total_pages),
                });
            }

            // Apply generic text cleanup to both native-extracted and OCR text.
            // This collapses tab/space artifacts, rejoins hyphenated words, removes
            // stray punctuation noise lines, and normalises blank lines.
            if !md.is_empty() {
                md = crate::text_clean::clean_page_text(&md);
            }

            page_markdowns.push((page_num_1indexed, md));
        }

        let mut full_markdown = String::new();
        for (page_num, md) in &page_markdowns {
            full_markdown.push_str(&format!("<!-- page: {} -->\n\n", page_num));
            if !md.is_empty() {
                full_markdown.push_str(md);
                full_markdown.push_str("\n\n");
            }
        }

        on_progress(CompanionProgress {
            current_page: total_pages,
            total_pages,
            stage: "done".to_string(),
            is_ocr: used_ocr,
            message: format!("Extracted {} pages", total_pages),
        });

        Ok(CompanionResult {
            companion_path: None,
            markdown: full_markdown,
            page_count: page_markdowns.len() as u32,
            pdf_type: pdf_type_str,
            used_ocr,
            pages_needing_ocr,
        })
    }
}

fn document_fingerprint(path: &Path) -> Result<(u64, u64), String> {
    let meta = std::fs::metadata(path).map_err(|e| {
        eprintln!("[PDFium] document_fingerprint ERROR: Cannot stat {:?}: {}", path, e);
        format!("Cannot stat {path:?}: {e}")
    })?;
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
    let encoder = jpeg_encoder::Encoder::new(&mut jpeg_bytes, quality);
    encoder
        .encode(
            rgb_image.as_raw(),
            rgb_image.width() as u16,
            rgb_image.height() as u16,
            jpeg_encoder::ColorType::Rgb,
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

    // 2b. iPad builds keep synced courses in Documents/courses (Files-app
    //     visible). Guarded to iOS so the desktop never matches an unrelated
    //     ~/Documents/courses folder.
    if cfg!(target_os = "ios") {
        if let Ok(documents) = app.path().document_dir() {
            let candidate = documents.join("courses").join(&lower_id);
            if candidate.exists() {
                return Some(candidate);
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

fn find_library_dir_any(app: &tauri::AppHandle) -> Option<PathBuf> {
    if let Ok(app_data) = app.path().app_data_dir() {
        if let Ok(settings) = std::fs::read_to_string(app_data.join("settings.json")) {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&settings) {
                if let Some(dir) = value.get("data_dir").and_then(|d| d.as_str()) {
                    let candidate = PathBuf::from(dir).join("library");
                    if candidate.exists() {
                        return Some(candidate);
                    }
                }
            }
        }
        let candidate = app_data.join("library");
        if candidate.exists() {
            return Some(candidate);
        }
    }

    if cfg!(target_os = "ios") {
        if let Ok(documents) = app.path().document_dir() {
            let candidate = documents.join("library");
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }

    if let Ok(data_env) = std::env::var("DATA_DIR") {
        let candidate = PathBuf::from(data_env).join("library");
        if candidate.exists() {
            return Some(candidate);
        }
    }

    if let Ok(cwd) = std::env::current_dir() {
        for base in &[
            cwd.join("data").join("library"),
            cwd.join("..").join("data").join("library"),
            cwd.join("library"),
        ] {
            if base.exists() {
                return Some(base.clone());
            }
        }
    }

    None
}

/// Parses `courseasset://localhost/{course_id}/assets/{rel}` into its parts,
/// percent-decoding the path and rejecting traversal (`..`) or non-asset
/// targets. Shared by the iOS webview protocol handler and PDF path
/// resolution here.
pub fn parse_course_asset_uri(uri: &str) -> Option<(String, String)> {
    use percent_encoding::percent_decode_str;

    let rest = uri.strip_prefix("courseasset://")?;
    // Custom protocols carry a `localhost` authority on iOS/macOS
    // (`courseasset://localhost/...`); drop it if present.
    let rest = rest.strip_prefix("localhost/").unwrap_or(rest);
    let path = rest.split(['?', '#']).next().unwrap_or(rest);
    let decoded = percent_decode_str(path.trim_start_matches('/'))
        .decode_utf8()
        .ok()?;
    let mut segments = decoded.split('/');
    let course_id = segments.next()?;
    if course_id.is_empty()
        || !course_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.')
        || course_id.contains("..")
    {
        return None;
    }
    let rel = segments.collect::<Vec<_>>().join("/");
    if !rel.starts_with("assets/") || rel.split('/').any(|s| s == ".." || s.is_empty()) {
        return None;
    }
    Some((course_id.to_string(), rel))
}

pub fn resolve_pdf_path(app: &tauri::AppHandle, path_or_url: &str) -> PathBuf {
    let clean = path_or_url.trim();
    eprintln!("[PDF-Resolve] Resolving path: '{}'", clean);

    // courseasset://localhost/{course_id}/assets/{rel} — the iOS webview
    // protocol scheme; resolve it to disk so pdfium can open synced PDFs.
    if let Some((course_id, rel)) = parse_course_asset_uri(clean) {
        if let Some(course_dir) = find_course_dir_any(app, &course_id) {
            let path = course_dir.join(&rel);
            eprintln!("[PDF-Resolve] courseasset candidate: {:?} (exists: {})", path, path.exists());
            return path;
        }
    }

    // Check if it's a Library PDF URL: /api/library/pdf/{filename} or /api/library/files/{filename}
    if let Some(lib_sub) = clean
        .strip_prefix("/api/library/pdf/")
        .or_else(|| clean.strip_prefix("api/library/pdf/"))
        .or_else(|| clean.strip_prefix("/api/library/files/"))
        .or_else(|| clean.strip_prefix("api/library/files/"))
        .or_else(|| clean.strip_prefix("/api/library/file/"))
        .or_else(|| clean.strip_prefix("api/library/file/"))
    {
        let raw_filename = lib_sub.split('?').next().unwrap_or(lib_sub);
        let filename = percent_encoding::percent_decode_str(raw_filename)
            .decode_utf8_lossy()
            .to_string();
        if let Some(lib_dir) = find_library_dir_any(app) {
            let direct_path = lib_dir.join(&filename);
            eprintln!(
                "[PDF-Resolve] Library candidate: {:?} (exists: {})",
                direct_path,
                direct_path.exists()
            );
            if direct_path.exists() {
                return direct_path;
            }
        }
        if let Ok(app_data) = app.path().app_data_dir() {
            let direct_path = app_data.join("library").join(&filename);
            if direct_path.exists() {
                return direct_path;
            }
        }
    }

    // Check if it's an API asset URL: /api/courses/{course_id}/assets/{asset_subpath}
    if let Some(stripped) = clean
        .strip_prefix("/api/courses/")
        .or_else(|| clean.strip_prefix("api/courses/"))
    {
        if let Some((course_id, rest)) = stripped.split_once('/') {
            if let Some(asset_rel) = rest.strip_prefix("assets/") {
                if let Some(course_dir) = find_course_dir_any(app, course_id) {
                    let direct_path = course_dir.join("assets").join(asset_rel);
                    eprintln!(
                        "[PDF-Resolve] Direct candidate: {:?} (exists: {})",
                        direct_path,
                        direct_path.exists()
                    );
                    if direct_path.exists() {
                        return direct_path;
                    }
                    let alt_path = course_dir.join(asset_rel);
                    eprintln!(
                        "[PDF-Resolve] Alt candidate: {:?} (exists: {})",
                        alt_path,
                        alt_path.exists()
                    );
                    if alt_path.exists() {
                        return alt_path;
                    }
                    eprintln!(
                        "[PDF-Resolve] Neither exists yet, returning canonical direct path: {:?}",
                        direct_path
                    );
                    return direct_path;
                } else if let Ok(app_data) = app.path().app_data_dir() {
                    let target = app_data
                        .join("courses")
                        .join(course_id.to_lowercase())
                        .join("assets")
                        .join(asset_rel);
                    eprintln!(
                        "[PDF-Resolve] Course dir not found, target path: {:?} (exists: {})",
                        target,
                        target.exists()
                    );
                    return target;
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
    let q = quality.unwrap_or(80).clamp(20, 100);

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

#[tauri::command]
pub async fn pdf_generate_companion(
    app: tauri::AppHandle,
    state: tauri::State<'_, PdfEngineState>,
    path: String,
    force: Option<bool>,
    on_progress: tauri::ipc::Channel<CompanionProgress>,
) -> Result<CompanionResult, String> {
    let engine = engine_from_state(&state)?;
    let resolved = resolve_pdf_path(&app, &path);
    let force = force.unwrap_or(false);

    tauri::async_runtime::spawn_blocking(move || {
        let companion_path = resolved.with_extension("companion.md");

        // Freshness check: if companion exists and is newer than source PDF, read and return
        if !force && companion_path.exists() {
            if let (Ok(pdf_meta), Ok(comp_meta)) = (
                std::fs::metadata(&resolved),
                std::fs::metadata(&companion_path),
            ) {
                if comp_meta.modified().ok() >= pdf_meta.modified().ok() {
                    if let Ok(content) = std::fs::read_to_string(&companion_path) {
                        let page_count = content.matches("<!-- page:").count() as u32;
                        let _ = on_progress.send(CompanionProgress {
                            current_page: page_count as usize,
                            total_pages: page_count as usize,
                            stage: "done".to_string(),
                            is_ocr: false,
                            message: "Loaded cached companion".to_string(),
                        });
                        return Ok(CompanionResult {
                            companion_path: Some(companion_path.to_string_lossy().to_string()),
                            markdown: content,
                            page_count,
                            pdf_type: "TextBased".to_string(),
                            used_ocr: false,
                            pages_needing_ocr: vec![],
                        });
                    }
                }
            }
        }

        let bytes = std::fs::read(&resolved)
            .map_err(|e| format!("Cannot read PDF at {:?}: {}", resolved, e))?;

        let mut result = engine.extract_companion_markdown(&bytes, Some(&resolved), |p| {
            let _ = on_progress.send(p);
        })?;

        if let Err(e) = std::fs::write(&companion_path, &result.markdown) {
            eprintln!("[PDF-Companion] Warning: failed to write {:?}: {}", companion_path, e);
        } else {
            result.companion_path = Some(companion_path.to_string_lossy().to_string());
        }

        Ok(result)
    })
    .await
    .map_err(|e| format!("Companion generation task failed: {e}"))?
}

#[tauri::command]
pub async fn pdf_read_companion(
    app: tauri::AppHandle,
    path: String,
) -> Result<Option<String>, String> {
    let resolved = resolve_pdf_path(&app, &path);
    let companion_path = resolved.with_extension("companion.md");
    if companion_path.exists() {
        std::fs::read_to_string(&companion_path)
            .map(Some)
            .map_err(|e| format!("Failed to read companion: {e}"))
    } else {
        Ok(None)
    }
}

#[tauri::command]
pub async fn pdf_extract_companion_from_bytes(
    state: tauri::State<'_, PdfEngineState>,
    bytes: Vec<u8>,
    pdf_path: Option<String>,
    on_progress: tauri::ipc::Channel<CompanionProgress>,
) -> Result<CompanionResult, String> {
    let engine = engine_from_state(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        let path_buf = pdf_path.as_deref().map(Path::new);
        let mut result = engine.extract_companion_markdown(&bytes, path_buf, |p| {
            let _ = on_progress.send(p);
        })?;

        if let Some(ref p) = pdf_path {
            let comp_path = Path::new(p).with_extension("companion.md");
            if let Err(e) = std::fs::write(&comp_path, &result.markdown) {
                eprintln!("[PDF-Companion] Warning: failed to write {:?}: {}", comp_path, e);
            } else {
                result.companion_path = Some(comp_path.to_string_lossy().to_string());
            }
        }

        Ok(result)
    })
    .await
    .map_err(|e| format!("In-memory companion extraction failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::OnceLock;

    static SHARED_ENGINE: OnceLock<PdfEngine> = OnceLock::new();

    fn get_engine() -> &'static PdfEngine {
        SHARED_ENGINE.get_or_init(|| PdfEngine::new().expect("failed to init PdfEngine"))
    }

    #[test]
    fn test_companion_extraction_from_sample_pdf() {
        let sample_path = Path::new("../data.old/courses/gwl3o/assets/locker_docs/gwl3o_03.02.05.pdf");
        if !sample_path.exists() {
            eprintln!("Sample PDF not found, skipping test");
            return;
        }

        let bytes = std::fs::read(sample_path).expect("failed to read sample PDF");
        let engine = get_engine();
        let mut progress_events = Vec::new();
        let result = engine
            .extract_companion_markdown(&bytes, Some(sample_path), |p| progress_events.push(p))
            .expect("failed to extract companion markdown");

        assert!(result.page_count > 0);
        assert!(result.markdown.contains("<!-- page: 1 -->"));
        assert!(!progress_events.is_empty());
        assert_eq!(progress_events.last().unwrap().stage, "done");
        println!("Extracted {} pages. PDF type: {}", result.page_count, result.pdf_type);
        println!("Sample markdown preview:\n{}", &result.markdown[..result.markdown.len().min(300)]);
    }

    #[test]
    fn test_native_ocr_on_rendered_page() {
        let sample_path = Path::new("../data.old/courses/gwl3o/assets/locker_docs/gwl3o_03.02.05.pdf");
        if !sample_path.exists() {
            return;
        }

        let engine = get_engine();
        let png = engine.render_page_png(sample_path, 0, 2.0).expect("failed to render png");
        assert!(!png.is_empty());

        if crate::ocr::is_ocr_supported() {
            let ocr_result = crate::ocr::run_native_ocr(&png).expect("native ocr failed");
            assert!(!ocr_result.is_empty());
            println!("Native OCR text preview:\n{}", &ocr_result[..ocr_result.len().min(300)]);
        }
    }
}
