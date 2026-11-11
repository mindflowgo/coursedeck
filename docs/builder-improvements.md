# Course Builder — Architecture Review & Improvement Roadmap

> **Scope:** `/builder` route (`+page.svelte`), `/api/builder/*` endpoints in `api.ts`, `pdfText.ts`, the Tauri `pdf.rs` native layer, and the library upload pipeline.
> **Central goal:** For every PDF or EPUB uploaded — whether through the Course Builder or the Library — generate a **companion Markdown sidecar** that captures the full document content with embedded page-number annotations. This sidecar becomes the single, reusable source of truth that the LLM reads during curriculum generation, lesson generation, and any future AI task, removing the need to re-extract text on every request.

---

## 1. Current Architecture — What Exists Today

```
┌─────────────────────────────────────────────────────────┐
│  /builder  (SvelteKit page)                             │
│  Mode: "ai" | "archive" | "manual"                      │
│  File accepted:  .pdf, .html, .htm, plain text           │
│  EPUB:           listed in MIME table, NOT handled       │
└──────────────┬──────────────────────────────────────────┘
               │  POST /api/builder/propose  (FormData or JSON)
               ▼
┌─────────────────────────────────────────────────────────┐
│  api.ts  /api/builder/propose                           │
│                                                         │
│  PDF   → extractTextFromPdf()  (pdfText.ts / pdf-parse) │
│  HTML  → cheerio strip tags                             │
│  text  → raw UTF-8                                      │
│  EPUB  → ❌ falls through to UTF-8 (binary garbage)     │
│                                                         │
│  Truncate flat to 60 000 chars (loses most textbooks)   │
│  Build userPrompt: filename + raw text + instructions   │
│  Call LLMService.generateResult()                       │
│  Parse JSON → normalizeProposal()                       │
└─────────────────────────────────────────────────────────┘

Library upload pipeline:
  PDF → stored in data/library/*.pdf
  No text extraction, no companion file generated. ❌

pdfText.ts:
  Uses pdf-parse (JS) — layout-unaware, no page tracking.
  Breaks on multi-column, tables, scanned pages.

Tauri pdf.rs (pdfium_render):
  Provides rendering + per-page TextSpan[] for the VIEWER.
  Never used by the builder or library pipelines. ❌
```

### Current Gaps

| # | Issue | Impact |
|---|-------|--------|
| 1 | `pdf-parse` produces layout-broken text on complex PDFs | Garbled curriculum output |
| 2 | EPUB completely unhandled | Builder crashes or garbage output |
| 3 | No page-number tracking anywhere in the extraction pipeline | LLM cannot correlate text to book pages; `pageRange` must be filled manually |
| 4 | No companion Markdown file — text re-extracted on every build/lesson-gen request | Repeated slow extraction; no reusable asset |
| 5 | 60 000-char flat truncation silently drops most textbook content | Wrong unit boundaries, missed chapters |
| 6 | PDFium native layer (already in Tauri) never used by build or library pipelines | Better extractor sitting idle |
| 7 | Scanned PDFs produce empty text — no OCR fallback | Image-only textbooks completely unsupported |
| 8 | Library PDFs have no AI-readable form at all | Library documents cannot feed future AI features |

---

## 2. New Architecture: The Companion Markdown Sidecar

### 2.1 Core Principle

Every PDF or EPUB that enters the system — via Builder upload or Library upload — triggers a **one-time extraction** that produces a companion `.companion.md` file stored alongside the original document. This file:

- Contains the full document text formatted as clean, structured Markdown
- Embeds page-boundary annotations the LLM can parse to correlate text ↔ page numbers
- Is generated once and reused forever (invalidated only if the source file changes)
- Replaces all ad-hoc calls to `pdf-parse` / `extractTextFromPdf` throughout the codebase

```
data/
  library/
    course_textbook.pdf
    course_textbook.companion.md   ← new, generated on upload
  courses/
    sph4u/
      assets/locker_docs/
        course.pdf
        course.companion.md        ← new, generated on PDF upload to course
```

### 2.2 Page-Number Format in the Sidecar

Each page's content is wrapped in an HTML comment annotation that passes through Markdown renderers invisibly but is trivially parseable by code or LLMs:

```markdown
<!-- page: 1 -->

# Chapter 1: Introduction to Kinematics

Motion is the change in position of an object over time...

<!-- page: 2 -->

## 1.1 Displacement and Velocity

Displacement is a vector quantity defined as...

| Symbol | Quantity       | Unit |
|--------|----------------|------|
| d      | Displacement   | m    |
| v      | Velocity       | m/s  |

<!-- page: 3 -->
...
```

The LLM prompt instructs the model: *"page annotations appear as `<!-- page: N -->`. Use these to populate `pageRange` fields."* This is explicit, zero-ambiguity correlation.

---

## 3. pdf-inspector as the Core Extraction Engine

### 3.1 Why pdf-inspector Replaces pdf-parse

`pdf-parse` is a basic text dumper. `@firecrawl/pdf-inspector` is purpose-built for exactly this use case — layout-aware Markdown extraction for LLM ingestion:

| Capability | `pdf-parse` | `pdf-inspector` |
|-----------|-------------|-----------------|
| Multi-column layout | ❌ reads across columns | ✅ column-aware reading order |
| Tables | ❌ raw strings | ✅ Markdown table output |
| Headings | ❌ flat text | ✅ H1–H4 from font size ratios |
| Lists / code blocks | ❌ flat text | ✅ preserved |
| Per-page output | ❌ single blob | ✅ `extract_pages_markdown()` returns page-indexed results |
| Document classification | ❌ none | ✅ `TextBased / Scanned / Mixed` + confidence |
| CID / Type0 font decoding | ❌ broken | ✅ ToUnicode CMap support |
| OCR routing | ❌ none | ✅ `route_ocr_pages()` with pluggable `OcrEngine` trait |
| Bun / Node.js bindings | ✅ | ✅ `@firecrawl/pdf-inspector` via napi-rs |

### 3.2 Server-Side Installation (Bun / Node)

```bash
bun add @firecrawl/pdf-inspector
```

The package ships prebuilt napi-rs binaries for macOS ARM64, Linux x64/ARM64, Windows x64 — no compile step. For environments without a prebuilt binary (e.g., cross-compiled iOS sidecar), fall back to the WASM variant `@firecrawl/pdf-inspector-wasm`.

### 3.3 New Module: `app/src/lib/server/pdfCompanion.ts`

This module is the **single entry point** for all PDF-to-Markdown extraction in the codebase. It replaces `pdfText.ts` for builder use and adds companion-file generation for both builder and library flows.

```typescript
import { processPdf, classifyPdf, extractPagesMarkdown } from '@firecrawl/pdf-inspector';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export interface CompanionResult {
  markdown: string;
  pageCount: number;
  pdfType: 'TextBased' | 'Scanned' | 'ImageBased' | 'Mixed';
  usedOcr: boolean;
  companionPath?: string; // set when written to disk
}

/**
 * Extracts structured Markdown with page annotations from a PDF buffer.
 * Uses pdf-inspector for layout-aware extraction.
 * For scanned/image pages, routes through the platform-native OCR engine
 * (see §4 — NativeOcrEngine implementation).
 */
export async function extractPdfToMarkdown(
  buffer: Buffer,
  opts: { ocrEngine?: any } = {}
): Promise<CompanionResult> {
  const bytes = new Uint8Array(buffer);

  // Fast classification first (~10–50ms)
  const classification = classifyPdf(bytes);
  const needsOcr =
    classification.pdfType === 'Scanned' ||
    classification.pdfType === 'ImageBased';

  let pages: Array<{ page: number; markdown: string; needsOcr?: boolean }>;
  let usedOcr = false;

  if (needsOcr && opts.ocrEngine) {
    // Scanned path: use pdf-inspector's vision pipeline with native OCR engine
    // (see §4 for NativeOcrEngine — wraps apple-vision or win_ocr via Tauri IPC)
    pages = await extractWithNativeOcr(bytes, opts.ocrEngine);
    usedOcr = true;
  } else {
    // Digital PDF path: pure layout-aware extraction
    pages = extractPagesMarkdown(bytes);
  }

  // Assemble sidecar with page annotations
  const markdown = assembleCompanionMarkdown(pages);

  return {
    markdown,
    pageCount: pages.length,
    pdfType: classification.pdfType as CompanionResult['pdfType'],
    usedOcr,
  };
}

/**
 * Generates or retrieves the companion Markdown for a PDF on disk.
 * Returns the cached file if it exists and the PDF hasn't changed.
 */
export async function ensureCompanion(
  pdfPath: string,
  opts: { ocrEngine?: any; force?: boolean } = {}
): Promise<CompanionResult> {
  const companionPath = pdfPath.replace(/\.pdf$/i, '.companion.md');

  if (!opts.force && fs.existsSync(companionPath)) {
    // Validate freshness: compare PDF mtime against companion mtime
    const pdfMtime = fs.statSync(pdfPath).mtimeMs;
    const compMtime = fs.statSync(companionPath).mtimeMs;
    if (compMtime >= pdfMtime) {
      const markdown = fs.readFileSync(companionPath, 'utf8');
      const pageCount = (markdown.match(/<!-- page: \d+ -->/g) || []).length;
      return { markdown, pageCount, pdfType: 'TextBased', usedOcr: false, companionPath };
    }
  }

  const buffer = fs.readFileSync(pdfPath);
  const result = await extractPdfToMarkdown(buffer, opts);
  fs.writeFileSync(companionPath, result.markdown, 'utf8');

  return { ...result, companionPath };
}

/**
 * Assembles the final sidecar Markdown from per-page results.
 * Injects <!-- page: N --> boundary annotations.
 */
function assembleCompanionMarkdown(
  pages: Array<{ page: number; markdown: string }>
): string {
  return pages
    .map(({ page, markdown }) => {
      // pdf-inspector uses 0-indexed pages; convert to 1-indexed for human readability
      const pageNum = page + 1;
      return `<!-- page: ${pageNum} -->\n\n${markdown.trim()}`;
    })
    .join('\n\n');
}
```

### 3.4 EPUB Extraction

EPUB is a ZIP of HTML spine chapters. Use `epub2` (npm) to extract chapters and convert to the same page-annotated format, substituting "page" with "chapter" annotations:

```typescript
// app/src/lib/server/epubCompanion.ts
import Epub from 'epub2';
import { load as cheerioLoad } from 'cheerio';
import { writeTempBuffer } from './tempUtil';

export async function extractEpubToMarkdown(buffer: Buffer): Promise<{
  markdown: string;
  chapterCount: number;
}> {
  const tmp = await writeTempBuffer(buffer, '.epub');
  const epub = await Epub.createAsync(tmp);

  const chapters = await Promise.all(
    epub.flow.map(async (item, idx) => {
      const html = await epub.getChapterAsync(item.id);
      const $ = cheerioLoad(html);
      $('script, style').remove();
      const text = $('body').text().trim();
      return { idx: idx + 1, title: item.title || `Chapter ${idx + 1}`, text };
    })
  );

  const markdown = chapters
    .filter(c => c.text.length > 50)
    .map(c => `<!-- page: ${c.idx} -->\n\n## ${c.title}\n\n${c.text}`)
    .join('\n\n');

  return { markdown, chapterCount: chapters.length };
}
```

> [!NOTE]
> For EPUBs, `<!-- page: N -->` represents chapter number, not physical page. The LLM prompt notes this distinction so `pageRange` fields use chapter references like "Chapter 3–4" rather than physical page numbers.

---

## 4. Native Platform OCR via pdf-inspector's OcrEngine Trait

### 4.1 Does PDFium OCR?

**No.** PDFium reads only the character stream embedded in the PDF's content. A scanned PDF (flat bitmap pages) returns empty `TextSpan[]`. `pdf-parse` has the same limitation.

`pdf-inspector` detects this automatically and provides a pluggable `OcrEngine` trait specifically so you can inject a platform-native OCR engine into its pipeline — getting the benefit of pdf-inspector's layout reconstruction and `fuse_ocr_pages` Markdown assembly on top of the OCR output.

### 4.2 The Two-Layer Architecture

```
Scanned PDF bytes
      │
      ▼ pdf-inspector classifyPdf()  → "Scanned" | "Mixed"
      │
      ▼ route_ocr_pages(OcrMode::Auto)
      │   → list of page indices needing OCR
      │
      ▼ PdfiumRenderer.render_page(idx, dpi=200)
      │   → RGB pixel buffer per page
      │
      ▼ NativeOcrEngine.recognize(pixel_buffer)
      │   ┌─ macOS/iOS → apple-vision crate (VNRecognizeTextRequest)
      │   └─ Windows   → win_ocr crate (Windows.Media.Ocr)
      │   → positioned text spans with confidence
      │
      ▼ fuse_ocr_pages(native_pages, ocr_results)
      │   → seamlessly merges OCR text into pdf-inspector's
      │     reading-order + Markdown generation pipeline
      │
      ▼ Per-page Markdown with preserved structure
```

### 4.3 Cargo Dependencies (cfg-gated, no new runtime binaries)

```toml
# tauri/Cargo.toml

[dependencies]
pdf-inspector = { version = "1", default-features = false, features = ["vision"] }
# "vision" enables OcrEngine + PageRenderer traits WITHOUT bundling ocr-oar (the ONNX model)
# "render-pdfium" is NOT needed — we reuse our existing pdfium-render for rendering

# macOS / iOS: Apple Vision framework
[target.'cfg(target_os = "macos")'.dependencies]
apple-vision = { version = "0.17", features = ["recognize_text"] }

[target.'cfg(target_os = "ios")'.dependencies]
apple-vision = { version = "0.17", features = ["recognize_text"] }

# Windows: WinRT OCR engine
[target.'cfg(target_os = "windows")'.dependencies]
win_ocr = "0.1"
```

> [!IMPORTANT]
> We use `features = ["vision"]` only — **not** `features = ["render-pdfium"]`. This avoids pulling in pdf-inspector's own firecrawl-pdfium dependency, which would conflict with our existing `pdfium-render = "0.8"`. The `PdfiumRenderer` for OCR page rendering is provided by our existing `PdfEngine` (it already has `render_page_to_rgb_image` at configurable scale).

### 4.4 NativeOcrEngine Implementation (`tauri/src/ocr.rs`)

```rust
use pdf_inspector::vision::{OcrEngine, OcrResult, OcrError, PageImage};

// ── macOS / iOS ───────────────────────────────────────────────────────────────

#[cfg(any(target_os = "macos", target_os = "ios"))]
pub struct NativeOcrEngine;

#[cfg(any(target_os = "macos", target_os = "ios"))]
impl OcrEngine for NativeOcrEngine {
    fn recognize(&self, page: &PageImage) -> Result<OcrResult, OcrError> {
        use apple_vision::prelude::*;
        use std::io::Write;

        // pdf-inspector passes an RGB/RGBA pixel buffer; write to temp PNG
        // so apple-vision can accept it via recognize_in_path
        let tmp = std::env::temp_dir().join(format!("ocr_page_{}.png", page.page_index));
        let rgb = image::RgbImage::from_raw(page.width, page.height, page.pixels.clone())
            .ok_or_else(|| OcrError::ProcessingFailed("Invalid pixel buffer".into()))?;
        image::DynamicImage::ImageRgb8(rgb)
            .save_with_format(&tmp, image::ImageFormat::Png)
            .map_err(|e| OcrError::ProcessingFailed(e.to_string()))?;

        let recognizer = TextRecognizer::new()
            .with_recognition_level(RecognitionLevel::Accurate)
            .with_language_correction(true);

        let observations = recognizer
            .recognize_in_path(tmp.to_str().unwrap())
            .map_err(|e| OcrError::EngineError(e.to_string()))?;

        let _ = std::fs::remove_file(&tmp);

        let text = observations
            .iter()
            .map(|o| o.text.as_str())
            .collect::<Vec<_>>()
            .join("\n");

        Ok(OcrResult {
            text,
            confidence: observations.iter()
                .map(|o| o.confidence)
                .fold(0.0_f32, f32::max),
        })
    }
}

// ── Windows ───────────────────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
pub struct NativeOcrEngine;

#[cfg(target_os = "windows")]
impl OcrEngine for NativeOcrEngine {
    fn recognize(&self, page: &PageImage) -> Result<OcrResult, OcrError> {
        let tmp = std::env::temp_dir().join(format!("ocr_page_{}.png", page.page_index));
        let rgb = image::RgbImage::from_raw(page.width, page.height, page.pixels.clone())
            .ok_or_else(|| OcrError::ProcessingFailed("Invalid pixel buffer".into()))?;
        image::DynamicImage::ImageRgb8(rgb)
            .save_with_format(&tmp, image::ImageFormat::Png)
            .map_err(|e| OcrError::ProcessingFailed(e.to_string()))?;

        let text = win_ocr::ocr(tmp.to_str().unwrap())
            .map_err(|e| OcrError::EngineError(e.to_string()))?;

        let _ = std::fs::remove_file(&tmp);
        Ok(OcrResult { text, confidence: 1.0 })
    }
}

// ── Unsupported (Linux, etc.) ─────────────────────────────────────────────────

#[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "windows")))]
pub struct NativeOcrEngine;

#[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "windows")))]
impl OcrEngine for NativeOcrEngine {
    fn recognize(&self, _page: &PageImage) -> Result<OcrResult, OcrError> {
        Err(OcrError::EngineError("Platform OCR not available".into()))
    }
}
```

### 4.5 Tauri Command: `pdf_generate_companion`

This command runs the full extraction pipeline (classification → OCR routing if needed → `fuse_ocr_pages` → Markdown assembly) and writes the `.companion.md` to disk alongside the PDF.

```rust
// tauri/src/pdf.rs — add alongside existing commands

use crate::ocr::NativeOcrEngine;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct CompanionResult {
    pub companion_path: String,
    pub page_count: u32,
    pub pdf_type: String,   // "TextBased" | "Scanned" | "Mixed" | "ImageBased"
    pub used_ocr: bool,
}

#[tauri::command]
pub async fn pdf_generate_companion(
    app: tauri::AppHandle,
    state: tauri::State<'_, PdfEngineState>,
    path: String,
    force: Option<bool>,
) -> Result<CompanionResult, String> {
    let engine = engine_from_state(&state)?;
    let resolved = resolve_pdf_path(&app, &path);
    let force = force.unwrap_or(false);

    tauri::async_runtime::spawn_blocking(move || {
        generate_companion_inner(&engine, &resolved, force)
    })
    .await
    .map_err(|e| format!("Companion generation task failed: {e}"))?
}

fn generate_companion_inner(
    engine: &PdfEngine,
    pdf_path: &std::path::Path,
    force: bool,
) -> Result<CompanionResult, String> {
    use pdf_inspector::vision::{route_ocr_pages, run_ocr_pages, fuse_ocr_pages, OcrMode, OcrOptions};
    use pdf_inspector::{process_pdf, extract_pages_markdown};

    let companion_path = pdf_path.with_extension("companion.md");

    // Freshness check
    if !force && companion_path.exists() {
        if let (Ok(pdf_meta), Ok(comp_meta)) = (
            std::fs::metadata(pdf_path),
            std::fs::metadata(&companion_path),
        ) {
            if comp_meta.modified().ok() >= pdf_meta.modified().ok() {
                let page_count = std::fs::read_to_string(&companion_path)
                    .map(|md| md.matches("<!-- page:").count() as u32)
                    .unwrap_or(0);
                return Ok(CompanionResult {
                    companion_path: companion_path.to_string_lossy().to_string(),
                    page_count,
                    pdf_type: "TextBased".to_string(),
                    used_ocr: false,
                });
            }
        }
    }

    let bytes = std::fs::read(pdf_path)
        .map_err(|e| format!("Cannot read PDF: {e}"))?;

    // Classify the document
    let classification = pdf_inspector::classify_pdf(&bytes)
        .map_err(|e| format!("Classification failed: {e}"))?;

    let (markdown_pages, used_ocr) = match classification.pdf_type.as_str() {
        "Scanned" | "ImageBased" | "Mixed" => {
            // Route pages needing OCR
            let opts = OcrOptions::default().mode(OcrMode::Auto);
            let route = route_ocr_pages(&classification, &opts);

            if route.is_empty() {
                // Classification said mixed but routing found nothing — treat as text
                (extract_pages_markdown(&bytes)
                    .map_err(|e| format!("Extraction failed: {e}"))?, false)
            } else {
                // Render flagged pages via our existing PdfEngine and run native OCR
                let ocr_engine = NativeOcrEngine;
                let ocr_run = run_ocr_pages_with_engine(engine, pdf_path, &bytes, &route, &ocr_engine)?;
                let base_pages = extract_pages_markdown(&bytes)
                    .unwrap_or_default();
                let fused = fuse_ocr_pages(&base_pages, &ocr_run, base_pages.len());
                (fused, true)
            }
        }
        _ => (
            extract_pages_markdown(&bytes)
                .map_err(|e| format!("Extraction failed: {e}"))?,
            false,
        ),
    };

    // Assemble companion Markdown with page annotations
    let companion_md: String = markdown_pages
        .iter()
        .enumerate()
        .map(|(idx, page_md)| format!("<!-- page: {} -->\n\n{}", idx + 1, page_md.trim()))
        .collect::<Vec<_>>()
        .join("\n\n");

    std::fs::write(&companion_path, &companion_md)
        .map_err(|e| format!("Cannot write companion file: {e}"))?;

    Ok(CompanionResult {
        companion_path: companion_path.to_string_lossy().to_string(),
        page_count: markdown_pages.len() as u32,
        pdf_type: classification.pdf_type,
        used_ocr,
    })
}

/// Bridge: render pages via our PdfEngine (high-DPI bitmap) then pass to OcrEngine.
/// This avoids enabling pdf-inspector's render-pdfium feature (which would conflict).
fn run_ocr_pages_with_engine(
    pdf_engine: &PdfEngine,
    pdf_path: &std::path::Path,
    raw_bytes: &[u8],
    route: &[u16],  // page indices to OCR
    ocr_engine: &dyn pdf_inspector::vision::OcrEngine,
) -> Result<Vec<pdf_inspector::vision::OcrPageResult>, String> {
    route.iter().map(|&page_idx| {
        // Render at 200 DPI (scale ≈ 2.78 at 72 pt base)
        let png_bytes = pdf_engine.render_page_png(pdf_path, page_idx, 2.78)?;
        let page_image = pdf_inspector::vision::PageImage::from_png_bytes(&png_bytes, page_idx)
            .map_err(|e| format!("PageImage conversion failed: {e}"))?;
        ocr_engine.recognize(&page_image)
            .map(|result| pdf_inspector::vision::OcrPageResult { page_index: page_idx, result })
            .map_err(|e| format!("OCR failed for page {page_idx}: {e}"))
    }).collect()
}
```

Register the new command in `lib.rs`:
```rust
pdf::pdf_generate_companion,
```

---

## 5. Where Companion Files Are Generated

### 5.1 Trigger Points

| Upload path | Trigger | Companion location |
|-------------|---------|-------------------|
| Builder — PDF uploaded for AI proposal | After upload, before LLM call | `temp/` (ephemeral, not persisted) |
| Builder — PDF attached as course book | After course creation, on PDF save | `courses/<id>/assets/locker_docs/course.companion.md` |
| Library — PDF/EPUB uploaded | On upload completion | `library/<filename>.companion.md` |

### 5.2 Server-Side API Changes (`api.ts`)

**Library upload** — after saving the file, queue companion generation:

```typescript
// In POST /api/library/upload (or equivalent)
import { extractPdfToMarkdown } from './pdfCompanion';

// After fs.writeFileSync(destPath, buffer):
if (ext === '.pdf') {
  // Non-blocking: generate companion in background
  extractPdfToMarkdown(buffer, { ocrEngine: tauriOcrBridge })
    .then(result => {
      const companionPath = destPath.replace(/\.pdf$/i, '.companion.md');
      fs.writeFileSync(companionPath, result.markdown, 'utf8');
    })
    .catch(err => console.warn('[Library] Companion generation failed:', err));
}
```

**Locker-docs upload** (`/api/courses/:id/locker-docs`) — same pattern after writing `course.pdf`.

**For Tauri desktop builds**, invoke `pdf_generate_companion` from the frontend after the file is written to disk — this runs the faster native pipeline.

### 5.3 Frontend — Trigger in Builder and Library Upload

```typescript
// app/src/lib/tauri/pdfCompanion.ts
import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '$lib/tauri';

export interface CompanionResult {
  companion_path: string;
  page_count: number;
  pdf_type: string;
  used_ocr: boolean;
}

export async function generateCompanion(pdfPath: string, force = false): Promise<CompanionResult> {
  if (!isTauri()) throw new Error('generateCompanion requires Tauri runtime');
  return invoke<CompanionResult>('pdf_generate_companion', { path: pdfPath, force });
}
```

---

## 6. Using the Companion in the Builder LLM Prompt

### 6.1 Updated `/api/builder/propose` Flow

```
POST /api/builder/propose
  │
  ├─ If file uploaded AND companion exists alongside it:
  │    Read companion.md directly — skip all extraction logic
  │
  ├─ If file uploaded AND no companion:
  │    Run extractPdfToMarkdown(buffer) → get markdown inline
  │    (companion not persisted for ephemeral builder uploads)
  │
  └─ If text pasted:
       Use text as-is
```

```typescript
// In /api/builder/propose handler:

let documentMarkdown = '';
let filename = 'document';

if (contentType.includes('multipart/form-data')) {
  const formData = await req.formData();
  const file = formData.get('file') as File | null;
  const companionText = formData.get('companionMarkdown') as string | null;

  if (companionText) {
    // Frontend sent pre-generated companion (Tauri path)
    documentMarkdown = companionText;
    filename = (formData.get('filename') as string) || 'document.pdf';
  } else if (file) {
    filename = file.name;
    const ext = path.extname(filename).toLowerCase();
    const buffer = Buffer.from(await file.arrayBuffer());

    if (ext === '.pdf') {
      const { extractPdfToMarkdown } = await import('./pdfCompanion');
      const result = await extractPdfToMarkdown(buffer);
      documentMarkdown = result.markdown;
    } else if (ext === '.epub') {
      const { extractEpubToMarkdown } = await import('./epubCompanion');
      const result = await extractEpubToMarkdown(buffer);
      documentMarkdown = result.markdown;
    } else if (ext === '.html' || ext === '.htm') {
      const cheerio = await import('cheerio');
      const $ = cheerio.load(buffer.toString('utf8'));
      $('script, style, nav, footer').remove();
      documentMarkdown = $('body').text().trim();
    } else {
      documentMarkdown = buffer.toString('utf8').trim();
    }
  }
}
```

### 6.2 Adaptive Truncation (Chapter-Proportional)

Instead of a flat 60 000-char cut, allocate budget proportionally across pages:

```typescript
function truncateCompanionForPrompt(markdown: string, maxChars = 80_000): string {
  // Split on page boundaries
  const pages = markdown.split(/(?=<!-- page: \d+ -->)/);
  const total = markdown.length;
  if (total <= maxChars) return markdown;

  // Proportional budget per page
  return pages.map(page => {
    const budget = Math.floor((page.length / total) * maxChars);
    return page.slice(0, budget);
  }).join('\n');
}
```

### 6.3 Updated System Prompt (Excerpt)

Add to the `FALLBACK_COURSE_BUILDER_PROMPT`:

```markdown
## Page Reference Instructions

The document content below includes page boundary annotations in the format:
`<!-- page: N -->` where N is the 1-indexed page number.

Use these page markers to populate each lesson's `pageRange` field.
For example, if Unit 1 Lesson 2 covers content between `<!-- page: 14 -->` and
`<!-- page: 28 -->`, set `"pageRange": "14-28"`.

Where page markers are chapter-based (EPUBs), set `pageRange` to the chapter
reference, e.g. `"pageRange": "Ch. 3-4"`.
```

---

## 7. normalizeProposal — Handle New Fields

Extend `normalizeProposal()` to pass through the new lesson fields:

```typescript
// Inside the lesson loop:
const lPageRange = typeof l.pageRange === 'string' ? l.pageRange.trim() : '';
const lReadingDesc = typeof l.readingDescription === 'string' ? l.readingDescription.trim() : '';
const lExternalRefs = Array.isArray(l.externalRefs)
  ? l.externalRefs
      .filter((r: any) => typeof r.label === 'string' && typeof r.url === 'string')
      .map((r: any) => ({
        label: String(r.label).slice(0, 120),
        url: String(r.url).slice(0, 500),
        type: ['video', 'article', 'tool', 'exercise'].includes(r.type) ? r.type : 'article',
      }))
  : [];

lessons.push({
  id: lId, title: lTitle, type: lType, content: lContent,
  pageRange: lPageRange || undefined,
  readingDescription: lReadingDesc || undefined,
  externalRefs: lExternalRefs.length ? lExternalRefs : undefined,
});
```

---

## 8. Enhanced Builder System Prompt

```markdown
# Course Builder Prompt

You are an expert curriculum architect and instructional designer.
Analyse the provided course material and produce a structured course curriculum.

## Primary Instructions

1. Identify course metadata:
   - "title", "suggestedId", "grade", "level", "description"

2. Structure into 3–6 sequential Units mapping to natural chapter groupings.

3. Within each unit, define Lessons:
   - "id": dot notation — "01.01", "01.02" etc.
   - "title": student-facing topic title
   - "type": "lesson" or "assignment"
   - "content": starter Markdown with Learning Goals and Key Concepts
   - "pageRange": page range from the source document (e.g. "14-28").
     Use the `<!-- page: N -->` markers in the content to determine this.
     Leave "" if not a book-based course.
   - "readingDescription": brief description of what those pages cover,
     e.g. "Chapter 2: Kinematics & Motion Graphs". Leave "" if not applicable.
   - "externalRefs": 0–3 curated external resources (videos, articles, tools).
     Each entry: { "label": string, "url": string, "type": "video"|"article"|"tool"|"exercise" }
     Prefer Khan Academy, CrashCourse, 3Blue1Brown, MIT OCW, PhET, OpenStax, Wikipedia.

## Output Format
Respond ONLY with valid JSON — no markdown backticks, no prose.
```

---

## 9. Frontend (`+page.svelte`) Changes

### 9.1 Upload Flow (Tauri Path)

```typescript
// In submitAiProposer(), Tauri branch:
if (isTauri() && aiFile) {
  const tempPath = await writeTempFile(aiFile);
  const companion = await generateCompanion(tempPath);

  // Read companion content and POST structured payload
  const companionText = await readTextFile(companion.companion_path);
  const formData = new FormData();
  formData.append('companionMarkdown', companionText);
  formData.append('filename', aiFile.name);
  // ... append instructions, targetUnits, customPrompt
  res = await apiFetch('/api/builder/propose', { method: 'POST', body: formData });
  ocrUsed = companion.used_ocr;
  ocrEngine = companion.pdf_type;
}
```

### 9.2 Accept EPUB

```typescript
function handleAiFileSelect(e: Event) {
  const input = e.target as HTMLInputElement;
  if (input.files?.[0]) {
    const file = input.files[0];
    if (/\.(pdf|epub)$/i.test(file.name) || file.type === 'application/epub+zip') {
      aiFile = file;
    }
  }
}
```

### 9.3 Display External References

```svelte
{#if lesson.externalRefs?.length}
  <div class="mt-2 space-y-1">
    <p class="text-2xs font-semibold text-stone-500 uppercase tracking-wide">Suggested Resources</p>
    {#each lesson.externalRefs as ref}
      <a href={ref.url} target="_blank" rel="noreferrer"
         class="flex items-center space-x-1.5 text-xs text-blue-600 dark:text-blue-400 hover:underline">
        <ExternalLink class="w-3 h-3 shrink-0" />
        <span>{ref.label}</span>
        <span class="text-stone-400 text-2xs">({ref.type})</span>
      </a>
    {/each}
  </div>
{/if}
```

### 9.4 OCR Status Indicator

```svelte
{#if ocrUsed}
  <div class="flex items-center space-x-1.5 text-xs text-amber-700 dark:text-amber-300 mt-1">
    <ScanLine class="w-3.5 h-3.5" />
    <span>Scanned PDF — text extracted via {ocrEngine === 'macos' ? 'Apple Vision' : 'Windows OCR'}.</span>
  </div>
{/if}
```

### 9.5 BuilderLesson Type

```typescript
interface ExternalRef {
  label: string;
  url: string;
  type: 'video' | 'article' | 'tool' | 'exercise';
}

interface BuilderLesson {
  id: string;
  title: string;
  type: 'lesson' | 'assignment';
  content: string;
  pageRange?: string;
  readingDescription?: string;
  externalRefs?: ExternalRef[];
  expanded?: boolean;
  preview?: boolean;
  generatingContent?: boolean;
}
```

---

## 10. Optional: Resource Enrichment Pass

A separate endpoint for post-proposal enrichment — keeps main propose fast:

```
POST /api/builder/enrich
Body: { courseTitle, lessons: [{ id, title }][] }

Secondary LLM call per lesson:
  "Suggest 2–3 high-quality educational resources for '{title}'
   in a {grade} {level} course on {courseTitle}.
   Prefer YouTube, Khan Academy, OpenStax, PhET.
   Return JSON: [{ label, url, type }]"
```

---

## 11. Implementation Sequence

```
Phase 0 — pdf-inspector + Companion Infrastructure (Rust + TS)
  [0a] cargo add pdf-inspector (features = ["vision"]) to tauri/Cargo.toml
  [0b] Add apple-vision (macOS/iOS) and win_ocr (Windows) cfg-gated deps
  [0c] Create tauri/src/ocr.rs — NativeOcrEngine impl OcrEngine (all platforms)
  [0d] Add PdfEngine::render_page_png() helper (reuses render_page_to_rgb_image)
  [0e] Add generate_companion_inner() + pdf_generate_companion Tauri command in pdf.rs
  [0f] Register pdf_generate_companion in lib.rs invoke_handler
  [0g] bun add @firecrawl/pdf-inspector in app/
  [0h] Create app/src/lib/server/pdfCompanion.ts (extractPdfToMarkdown, ensureCompanion)
  [0i] Create app/src/lib/server/epubCompanion.ts (bun add epub2)
  [0j] Create app/src/lib/tauri/pdfCompanion.ts (generateCompanion IPC helper)

Phase 1 — Library Upload Integration
  [1a] api.ts: trigger ensureCompanion() after every library PDF save
  [1b] api.ts: trigger ensureCompanion() after every locker-docs PDF save
  [1c] Library page: show companion generation status indicator

Phase 2 — Builder Propose Integration
  [2a] api.ts /api/builder/propose: accept companionMarkdown field
  [2b] api.ts: replace extractTextFromPdf() with extractPdfToMarkdown()
  [2c] api.ts: handle .epub via extractEpubToMarkdown()
  [2d] api.ts: apply proportional truncation (§6.2)
  [2e] api.ts: update FALLBACK_COURSE_BUILDER_PROMPT (§8)
  [2f] api.ts: extend normalizeProposal() for pageRange, externalRefs (§7)
  [2g] Builder page: call generateCompanion() in Tauri path, send companionMarkdown
  [2h] Builder page: accept .epub in file pickers
  [2i] Builder page: display externalRefs and OCR status (§9)

Phase 3 — Optional Enrichment
  [3a] api.ts: add /api/builder/enrich endpoint
  [3b] Builder prepare step: "Enrich with References" button
```

---

## 12. Key Design Decisions & Open Questions

| # | Question | Recommendation |
|---|----------|----------------|
| Q1 | Should companion generation block the upload response or run in background? | Background for library uploads (show a spinner state). Block for builder AI-propose since the companion is needed immediately. |
| Q2 | Companion for EPUBs — chapter-based "pages" vs physical pages? | Chapter-based is fine. Annotate with `<!-- page: N -->` for structural consistency; the LLM prompt explains they're chapters. |
| Q3 | What if pdf-inspector's `render-pdfium` conflicts with our `pdfium-render = "0.8"`? | Do NOT enable `render-pdfium` feature. Use our existing `PdfEngine::render_page_png()` as the `PageRenderer` bridge. Share the same binary via `PDFIUM_LIB_PATH`. |
| Q4 | Companion freshness: when to regenerate? | On mtime change of source PDF. Add a "Regenerate companion" button in the library file detail view. |
| Q5 | Should the companion be exposed via the API (for client-side use)? | Yes — add `GET /api/library/companion/:filename` and `GET /api/courses/:id/companion` that return the companion markdown. |
| Q6 | Windows OCR language packs missing? | `win_ocr` returns an `Err` gracefully. Surface a user-readable message pointing to Windows Language Settings. |
| Q7 | Linux support for OCR? | Out of scope for now. Companion generation on Linux falls back to digital-only extraction (no OCR). Log a warning if scanned pages are detected. |

---

## 13. Files to Create or Modify

| File | Change |
|------|--------|
| `tauri/Cargo.toml` | Add `pdf-inspector` (vision feature), `apple-vision` (macOS/iOS), `win_ocr` (Windows) under cfg-gated sections |
| `tauri/src/ocr.rs` | New: `NativeOcrEngine impl OcrEngine` for all platforms |
| `tauri/src/pdf.rs` | Add `render_page_png()` helper; add `generate_companion_inner()`; add `pdf_generate_companion` command |
| `tauri/src/lib.rs` | `mod ocr`; register `pdf::pdf_generate_companion` in invoke handler |
| `app/package.json` | `bun add @firecrawl/pdf-inspector epub2` |
| `app/src/lib/server/pdfCompanion.ts` | New: `extractPdfToMarkdown()`, `ensureCompanion()`, `assembleCompanionMarkdown()` |
| `app/src/lib/server/epubCompanion.ts` | New: `extractEpubToMarkdown()` |
| `app/src/lib/server/pdfText.ts` | Deprecate — keep as emergency fallback only, annotate with `// @deprecated use pdfCompanion.ts` |
| `app/src/lib/server/api.ts` | Update `/api/builder/propose`; add `/api/builder/enrich`; update `FALLBACK_COURSE_BUILDER_PROMPT`; update `normalizeProposal`; trigger `ensureCompanion` in library + locker-doc upload handlers |
| `app/src/lib/tauri/pdfCompanion.ts` | New: `generateCompanion()` IPC helper |
| `app/src/routes/builder/+page.svelte` | Tauri companion path; accept `.epub`; display `externalRefs` and OCR status |
| `app/src/routes/library/+page.svelte` | Show companion generation status; "Regenerate" button |
| `app/src/lib/server/api.builder.test.ts` | Tests for companion-based propose, EPUB, enriched proposal schema, OCR-flagged path |
