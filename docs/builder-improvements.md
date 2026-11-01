# Course Builder — Architecture Review & Improvement Roadmap

> **Scope:** `/builder` route (`+page.svelte`), `/api/builder/*` endpoints in `api.ts`, `pdfText.ts`, and the Tauri `pdf.rs` native layer.
> **Goal:** Accept PDF or EPUB input, extract text with higher fidelity (using the already-present PDFium native layer for the desktop app), and produce a richer LLM prompt that yields units + lessons **with** page references and curated external links/videos. Extends to native platform OCR (Apple Vision / Windows.Media.Ocr) for scanned / image-only PDFs.

---

## 1. Current Architecture — What Exists Today

```
┌─────────────────────────────────────────────────────────┐
│  /builder  (SvelteKit page)                             │
│  Mode: "ai" | "archive" | "manual"                     │
│                                                         │
│  Wizard steps: Define → Upload → Prepare               │
│  File accepted:  .pdf, .html, .htm, plain text          │
│  EPUB:           listed in MIME table, NOT handled      │
└──────────────┬──────────────────────────────────────────┘
               │  POST /api/builder/propose  (FormData or JSON)
               ▼
┌─────────────────────────────────────────────────────────┐
│  api.ts  /api/builder/propose                           │
│                                                         │
│  PDF   → extractTextFromPdf()  (pdfText.ts)             │
│  HTML  → cheerio strip tags                             │
│  text  → raw UTF-8                                      │
│  EPUB  → ❌ falls through to UTF-8 (binary garbage)     │
│                                                         │
│  Truncate to 60 000 chars                               │
│  Build userPrompt: filename + content + instructions    │
│  Call LLMService.generateResult()                       │
│  Parse JSON → normalizeProposal()                       │
└──────────────┬──────────────────────────────────────────┘
               │  proposal: { title, units[], lessons[] }
               ▼
┌─────────────────────────────────────────────────────────┐
│  pdfText.ts  (Node/Bun server-side)                     │
│  Uses pdf-parse (JS) — text only, no layout awareness   │
│  DOMMatrix polyfill required for compiled binary        │
└─────────────────────────────────────────────────────────┘

Tauri native layer (pdf.rs — pdfium_render)
  • pdf_get_info / pdf_render_page / pdf_render_thumbnail
  • pdf_get_page_text  ← per-page TextSpan[] via PDFium
  • pdf_search
  NOT yet invokable from the builder flow
```

### Current Gaps

| # | Issue | Impact |
|---|-------|--------|
| 1 | `pdf-parse` (JS) produces layout-broken text on complex PDFs (columns, figures, tables) | Garbled text → poor curriculum quality |
| 2 | EPUB support absent — binary passed as UTF-8 | Builder crashes or produces garbage for EPUB uploads |
| 3 | The existing PDFium native layer is **page-rendering only**; `pdf_get_page_text` returns `TextSpan[]` per page but is never called by the builder | Duplicated effort; the better extractor is sitting unused |
| 4 | Proposal schema has no `pageRange` or `readingDescription` fields — the LLM is never asked to emit them | Users must fill every page reference manually |
| 5 | No external resource enrichment (YouTube, Khan Academy, OpenStax, etc.) in the builder prompt or flow | Every lesson is entirely self-contained text |
| 6 | 60 000-char hard truncation is applied uniformly — a 400-page textbook loses ¾ of its content before the LLM sees it | Wrong unit boundaries, missed chapters |
| 7 | Single monolithic `api.ts` handles the entire builder pipeline — hard to test, extend, and maintain | Coupling between text extraction, LLM call, schema parsing |

---

## 2. Proposed Architecture

### 2.1 Layered Extraction Pipeline

```
Input file (PDF / EPUB / HTML / text)
       │
       ▼
┌──────────────────────────────────────┐
│  DocumentExtractor (new module)      │
│  server/lib/builder/extractor.ts     │
│                                      │
│  PDF  → strategy A  (see §3)         │
│  EPUB → strategy B  (see §4)         │
│  HTML → existing cheerio             │
│  text → passthrough                  │
│                                      │
│  Returns: ExtractionResult {         │
│    text: string;                     │
│    pageMap: PageMapEntry[];          │  ← new
│    toc: TocEntry[];                  │  ← new
│    metadata: DocMetadata;            │
│  }                                   │
└──────────┬───────────────────────────┘
           │
           ▼
┌──────────────────────────────────────┐
│  ContentChunker (new module)         │
│  server/lib/builder/chunker.ts       │
│                                      │
│  Splits by chapter/section headings  │
│  (TOC-aware for EPUB, PDFium-outline │
│   for PDF, h1/h2 for HTML)           │
│  Emits chunks with page_start/end    │
│  Respects LLM context window         │
└──────────┬───────────────────────────┘
           │
           ▼
┌──────────────────────────────────────┐
│  CurriculumArchitect (new module)    │
│  server/lib/builder/architect.ts     │
│                                      │
│  Builds structured LLM prompt        │
│  Includes TOC outline + chunked text │
│  Instructs LLM to emit pageRange     │
│  Instructs LLM to suggest references │
│  Calls LLMService.generateResult()   │
│  Validates + normalizes JSON output  │
└──────────┬───────────────────────────┘
           │
           ▼
┌──────────────────────────────────────┐
│  ResourceEnricher (new module)       │
│  server/lib/builder/enricher.ts      │
│                                      │
│  Optional post-processing step       │
│  Second LLM call (or search API)     │
│  Attaches video/link suggestions per │
│  lesson topic                        │
└──────────┬───────────────────────────┘
           │
           ▼
    EnrichedProposal {
      ...existing fields,
      units[].lessons[].pageRange,
      units[].lessons[].readingDescription,
      units[].lessons[].externalRefs[],
    }
```

---

## 3. PDF Extraction — Use PDFium via Tauri IPC

### 3.1 New Tauri Command: `pdf_extract_all_text`

The existing `pdf_get_page_text` returns `TextSpan[]` per single page. Add a bulk extractor that returns the full document text with page boundaries:

**`tauri/src/pdf.rs`** — add alongside existing commands:

```rust
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ExtractedPage {
    pub page_index: u16,
    pub text: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ExtractedDocument {
    pub page_count: u16,
    pub pages: Vec<ExtractedPage>,
}

#[tauri::command]
pub async fn pdf_extract_all_text(
    app: tauri::AppHandle,
    state: tauri::State<'_, PdfEngineState>,
    path: String,
    /// Optional: only extract pages in this (inclusive) range, 0-indexed.
    start_page: Option<u16>,
    end_page: Option<u16>,
) -> Result<ExtractedDocument, String> {
    let engine = engine_from_state(&state)?;
    let resolved = resolve_pdf_path(&app, &path);
    tauri::async_runtime::spawn_blocking(move || {
        engine.extract_all_text(&resolved, start_page, end_page)
    })
    .await
    .map_err(|e| format!("PDF text extraction task failed: {e}"))?
}
```

**`PdfEngine` impl** — new method reusing the per-page `get_page_text` cache:

```rust
pub fn extract_all_text(
    &self,
    path: &Path,
    start_page: Option<u16>,
    end_page: Option<u16>,
) -> Result<ExtractedDocument, String> {
    let info = self.get_info(path)?;
    let total = info.page_count;
    let start = start_page.unwrap_or(0);
    let end = end_page.map(|e| e.min(total)).unwrap_or(total);
    let mut pages = Vec::with_capacity((end - start) as usize);
    for idx in start..end {
        let spans = self.get_page_text(path, idx)?;
        // Re-join spans preserving reading order: sort by y, then x
        let mut sorted = spans.as_ref().clone();
        sorted.sort_by(|a, b| a.y.partial_cmp(&b.y).unwrap()
            .then(a.x.partial_cmp(&b.x).unwrap()));
        let text: String = sorted.iter()
            .map(|s| s.text.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        pages.push(ExtractedPage { page_index: idx, text });
    }
    Ok(ExtractedDocument { page_count: total, pages })
}
```

**Register in `lib.rs`** invoke handler:
```rust
pdf::pdf_extract_all_text,
```

### 3.2 Builder Page — Call Tauri IPC Before Uploading

When running inside Tauri (desktop), the builder should **not** upload the raw PDF bytes to the server for JS parsing. Instead:

1. Save the file to a temp path (or use a `File`-backed URL).
2. Call `invoke('pdf_extract_all_text', { path: tempPath })`.
3. Receive `ExtractedDocument` (structured, page-indexed).
4. POST the structured JSON to `/api/builder/propose` as `{ pages: ExtractedPage[], toc: ... }`.

For the **web/dev** server path (no Tauri), keep the existing `pdf-parse` fallback in `pdfText.ts`.

**Detection helper** in `+page.svelte`:

```typescript
import { isTauri } from '$lib/tauri'; // already used elsewhere

async function extractPdfText(file: File): Promise<ExtractionResult> {
  if (isTauri()) {
    const tempPath = await writeTempFile(file); // new helper, see §3.3
    const doc = await invoke<ExtractedDocument>('pdf_extract_all_text', { path: tempPath });
    return { pages: doc.pages, pageCount: doc.page_count };
  }
  // web fallback: upload raw bytes, let server-side pdf-parse handle it
  return { rawText: await file.text(), pageCount: 0 };
}
```

### 3.3 Temp File Helper (Tauri)

```typescript
// app/src/lib/tauri/tempFile.ts
import { invoke } from '@tauri-apps/api/core';
import { tempDir } from '@tauri-apps/api/path';
import { writeFile } from '@tauri-apps/plugin-fs';

export async function writeTempFile(file: File): Promise<string> {
  const dir = await tempDir();
  const dest = `${dir}/builder_upload_${Date.now()}_${file.name}`;
  const bytes = new Uint8Array(await file.arrayBuffer());
  await writeFile(dest, bytes);
  return dest;
}
```

---

## 4. EPUB Text Extraction

EPUBs are ZIP archives containing HTML spine documents and an OPF manifest. Use an existing JS/TS EPUB parser on the server side.

### 4.1 Recommended Library

**`epub2`** (npm) — battle-tested, returns chapter list + raw HTML per chapter.

```bash
bun add epub2
```

### 4.2 New Module: `server/lib/builder/epubExtractor.ts`

```typescript
import Epub from 'epub2';

export interface EpubChapter {
  title: string;
  text: string;     // stripped plain text
  order: number;
}

export async function extractTextFromEpub(buffer: Buffer): Promise<{
  title: string;
  chapters: EpubChapter[];
  rawText: string;
}> {
  // epub2 requires a file path; write to a temp file
  const tmp = await writeTempBuffer(buffer, '.epub');
  const epub = await Epub.createAsync(tmp);

  const chapters: EpubChapter[] = [];
  for (const item of epub.flow) {
    const html = await epub.getChapterAsync(item.id);
    const text = stripHtml(html);          // reuse cheerio
    if (text.trim().length > 50) {
      chapters.push({ title: item.title || '', text, order: item.order });
    }
  }

  const rawText = chapters.map(c => `\n\n## ${c.title}\n${c.text}`).join('');
  return { title: epub.metadata.title || '', chapters, rawText };
}
```

### 4.3 `api.ts` — Handle `.epub` in `/api/builder/propose`

```typescript
} else if (ext === '.epub') {
  try {
    const { extractTextFromEpub } = await import('./builder/epubExtractor');
    const result = await extractTextFromEpub(buffer);
    extractedText = result.rawText;
    // Pass chapter structure as structured TOC
    tocHint = result.chapters.map(c => c.title).join('\n');
  } catch (epubErr: any) {
    return error(400, `Failed to parse EPUB: ${epubErr?.message || String(epubErr)}`);
  }
}
```

---

## 5. LLM Prompt Improvements

### 5.1 Enhanced Builder System Prompt

The current `FALLBACK_COURSE_BUILDER_PROMPT` asks for units and lessons but does **not** ask the LLM to:
- Reference specific page numbers
- Suggest external video or reference links
- Honour a TOC if one is provided

**Updated fallback prompt template** (configurable via `course_builder` prompt in PromptService):

```markdown
# Course Builder Prompt

You are an expert curriculum architect and instructional designer.
Analyse the provided course material and produce a structured course curriculum.

## Primary Instructions

1. Identify course metadata:
   - "title": Clear, descriptive course title
   - "suggestedId": Short lowercase alphanumeric slug (e.g. "cs101", "mcr3u")
   - "grade": Target level (e.g. "11", "12", "Introductory", "Undergraduate")
   - "level": Academic stream (e.g. "University", "College", "Open", "AP")
   - "description": 2–4 sentence syllabus overview

2. Structure the curriculum into **3–6 sequential Units**. Each unit maps
   to a natural chapter grouping or thematic block in the source material.

3. Within each unit, define **individual Lessons** (and optional assignments):
   - "id": Two-digit dot notation — "01.01", "01.02" for Unit 1; "02.01" for Unit 2, etc.
   - "title": Student-facing topic title
   - "type": "lesson" or "assignment"
   - "content": Starter Markdown — include Learning Goals and Key Concepts headings
   - "pageRange": (if source is a book/PDF) The specific page range for this lesson,
     e.g. "14–28". Leave empty string "" if not applicable.
   - "readingDescription": Brief description of what the pages cover,
     e.g. "Chapter 2: Kinematics & Motion Graphs". Leave empty string "" if not applicable.
   - "externalRefs": Array of 0–3 curated external resources (videos, articles, tools)
     relevant to this lesson topic. Each entry:
       { "label": string, "url": string, "type": "video"|"article"|"tool"|"exercise" }
     Prefer YouTube (Khan Academy, CrashCourse, 3Blue1Brown, MIT OCW), Wikipedia,
     PhET simulations, and OpenStax. Only include resources you are confident exist.

## Output Format

Respond ONLY with a valid JSON object — no markdown backticks, no prose.

{
  "title": "...",
  "suggestedId": "...",
  "grade": "...",
  "level": "...",
  "description": "...",
  "units": [
    {
      "number": 1,
      "title": "Unit 1: ...",
      "lessons": [
        {
          "id": "01.01",
          "title": "...",
          "type": "lesson",
          "content": "...",
          "pageRange": "14-28",
          "readingDescription": "Chapter 1: ...",
          "externalRefs": [
            { "label": "Khan Academy – Intro to Topic", "url": "https://...", "type": "video" }
          ]
        }
      ]
    }
  ]
}
```

### 5.2 Structured Input: TOC + Chunked Content

Instead of dumping raw text, pass a structured document summary when available:

```typescript
function buildUserPrompt(opts: {
  filename: string;
  toc?: string;
  chunks: { heading: string; pages?: string; text: string }[];
  instructions?: string;
  targetUnits?: number;
}): string {
  let prompt = `Document: ${opts.filename}\n\n`;

  if (opts.toc) {
    prompt += `=== Table of Contents ===\n${opts.toc}\n\n`;
  }

  prompt += `=== Content Summary ===\n`;
  for (const chunk of opts.chunks) {
    prompt += `\n--- ${chunk.heading}`;
    if (chunk.pages) prompt += ` (pp. ${chunk.pages})`;
    prompt += ` ---\n${chunk.text.slice(0, 3000)}\n`;
  }

  if (opts.instructions) {
    prompt += `\n=== Additional Instructions ===\n${opts.instructions}\n`;
  }
  if (opts.targetUnits && opts.targetUnits > 0) {
    prompt += `\nTarget number of units: exactly ${opts.targetUnits}.\n`;
  }

  return prompt;
}
```

### 5.3 Adaptive Truncation Strategy

Rather than a flat 60 000-char limit, allocate the context budget proportionally across chapters:

```typescript
function smartTruncate(
  pages: ExtractedPage[],
  maxChars = 60_000,
  reservedForInstructions = 2_000
): { heading: string; pages: string; text: string }[] {
  const budget = maxChars - reservedForInstructions;
  const total = pages.reduce((s, p) => s + p.text.length, 0);
  return pages.map(p => ({
    heading: `Page ${p.page_index + 1}`,
    pages: String(p.page_index + 1),
    text: total > budget
      ? p.text.slice(0, Math.floor((p.text.length / total) * budget))
      : p.text,
  }));
}
```

---

## 6. normalizeProposal — Handle New Fields

Extend `normalizeProposal()` to pass through the new lesson fields:

```typescript
// In normalizeProposal, inside the lesson loop:
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

## 7. Frontend (`+page.svelte`) Changes

### 7.1 EPUB Upload Support

```typescript
// handleBookFileSelect — accept .epub too
if (file.name.match(/\.(pdf|epub)$/i) || file.type === 'application/epub+zip') {
  bookFile = file;
}
```

### 7.2 Display External References in Curriculum Studio

In the `prepare` step lesson editor, show a collapsible "External Resources" section populated from `lesson.externalRefs`:

```svelte
{#if lesson.externalRefs?.length}
  <div class="mt-2 space-y-1">
    <p class="text-2xs font-semibold text-stone-500 uppercase">Suggested Resources</p>
    {#each lesson.externalRefs as ref}
      <a href={ref.url} target="_blank" rel="noreferrer"
         class="flex items-center space-x-1 text-xs text-blue-600 hover:underline">
        <ExternalLink class="w-3 h-3" />
        <span>{ref.label}</span>
      </a>
    {/each}
  </div>
{/if}
```

### 7.3 BuilderLesson Type Update

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
  externalRefs?: ExternalRef[];   // ← new
  expanded?: boolean;
  preview?: boolean;
  generatingContent?: boolean;
}
```

---

## 8. Optional: Resource Enrichment as a Separate Step

If the LLM's own reference suggestions are insufficient or unreliable, add a **post-proposal enrichment** pass:

```
POST /api/builder/enrich
Body: { courseTitle, lessons: [{ id, title, topic }][] }

For each lesson, call a secondary LLM prompt:
  "Given the lesson topic '{title}' in a {grade} {level} course on {courseTitle},
   suggest 2–3 high-quality educational videos or articles. Prefer YouTube, Khan Academy,
   OpenStax, or PhET. Return JSON array: [{ label, url, type }]"

Merge results into the proposal and return to the frontend.
```

This keeps the main `/api/builder/propose` fast and makes enrichment opt-in.

---

## 9. Implementation Sequence

```
Phase 1 — PDF Quality Fix (backend, no Tauri change)
  [1a] Add pdf_extract_all_text Tauri command in pdf.rs
  [1b] Register in lib.rs invoke_handler
  [1c] Add writeTempFile() Tauri helper
  [1d] Builder page: detect Tauri, call IPC for PDF, send structured payload
  [1e] api.ts /api/builder/propose: accept structured { pages } input

Phase 2 — EPUB Support
  [2a] bun add epub2 in app/
  [2b] Add epubExtractor.ts
  [2c] api.ts: handle .epub ext
  [2d] +page.svelte: accept .epub in file pickers

Phase 3 — Prompt + Schema Improvements
  [3a] Update FALLBACK_COURSE_BUILDER_PROMPT with pageRange + externalRefs
  [3b] Update buildUserPrompt() with TOC-aware chunking
  [3c] Extend normalizeProposal() for new fields
  [3d] Extend BuilderLesson type + Prepare-step UI

Phase 4 — Optional Resource Enrichment
  [4a] Add /api/builder/enrich endpoint
  [4b] Add "Enrich with References" button in builder UI
  [4c] Add ResourceEnricher module
```

---

## 10. Key Decisions & Open Questions

| # | Question | Recommendation |
|---|----------|----------------|
| Q1 | Use PDFium for server-side extraction too (compiled binary) or keep `pdf-parse` as fallback? | Keep `pdf-parse` as web/dev fallback; PDFium is Tauri-only. For the future, consider also shipping a `pdfium-render` WASM build for the Bun sidecar. |
| Q2 | Should `externalRefs` be validated before saving (dead-link checking)? | Not in the builder — too slow. Validate lazily on lesson view or in an async background job. |
| Q3 | Chunk-based extraction vs. full-document for the LLM prompt? | Prefer chapter-level chunks. Most course books have ≤50 chapters; each chunk budget is 1–2k chars — well within a 64k–128k context window. |
| Q4 | EPUB via `epub2` vs. native Rust `epub` crate in Tauri? | JS `epub2` is simpler and available today. The Tauri approach is more robust for very large EPUBs but requires a new Rust module and cross-compiling. |
| Q5 | Should page references be confirmed/editable before course creation? | Yes — the `prepare` step's lesson editor should show `pageRange` as an editable field (it already exists in the UI for manual builds). |

---

---

## 12. OCR for Scanned / Image-Only PDFs

### 12.1 Does PDFium OCR?

**No.** PDFium's text extraction (`FPDFText_GetText`, and our `get_page_text`) reads the character stream already embedded in the PDF's font/content streams. For a scanned PDF — where each page is a flat bitmap with no embedded text — `get_page_text` returns an empty `Vec<TextSpan>`. The current `pdf-parse` JS fallback has the same limitation.

We can detect this condition cheaply: if `extract_all_text` returns pages where `text.trim().is_empty()` for ≥ 80 % of pages, the document is almost certainly image-only and needs OCR.

### 12.2 Platform OCR Options

| Option | macOS / iOS | Windows | Linux | Quality | Dependency |
|--------|-------------|---------|-------|---------|------------|
| **Apple Vision** (`apple-vision` crate) | ✅ macOS 10.15+ / iOS 13+ | ❌ | ❌ | ⭐⭐⭐⭐⭐ (Neural-engine accelerated) | `apple-vision = "0.17"` |
| **Windows.Media.Ocr** (`win_ocr` crate) | ❌ | ✅ Windows 10+ | ❌ | ⭐⭐⭐⭐ (built-in, no install needed) | `win_ocr = "0.1"` (wraps `windows` crate) |
| **Tesseract** (`leptess` / `tesseract-rs`) | ✅ | ✅ | ✅ | ⭐⭐⭐ | Requires external `tesseract` binary/lib |
| **`ocrs`** pure-Rust neural OCR | ✅ | ✅ | ✅ | ⭐⭐⭐ (Latin-script focused) | Bundles ONNX model (~30 MB) |

**Recommendation for this project:** use platform-native engines — zero extra binary to ship, no third-party license, and best accuracy. Fall back gracefully if the page is on an unsupported OS. Linux (unlikely target for this app) can use Tesseract as an optional compile-time feature.

### 12.3 Architecture: PDFium Render → Platform OCR

The pipeline reuses the **existing PDFium render infrastructure** in `pdf.rs` — the same `render_page_to_rgb_image()` helper already used by `pdf_render_page`. We render at high DPI (≥ 2.5× scale = ~180 DPI), convert to PNG bytes, hand off to the platform OCR engine, and collect text per page.

```
scanned PDF
  │
  ▼ pdf_extract_all_text()  (§3)
  │   → pages[i].text == ""  (all empty)
  │
  ▼ detect_image_only() → true
  │
  ▼ pdf_ocr_all_pages()  (new command)
      for each page:
        1. render_page_to_rgb_image(scale=2.5)  ← reuses existing fn
        2. encode to PNG bytes                  ← reuses existing fn
        3. write to temp file  (platform OCR APIs take a file path)
        4. call platform OCR:
             macOS  → apple_vision::TextRecognizer
             Windows → win_ocr::ocr()
        5. collect text string for page
      return Vec<OcrPage { page_index, text }>
```

### 12.4 New Tauri Command: `pdf_ocr_all_pages`

**`tauri/Cargo.toml`** — conditional dependencies (no new dep on non-Apple/Windows):

```toml
# macOS / iOS: Apple Vision OCR
[target.'cfg(target_os = "macos")'.dependencies]
apple-vision = { version = "0.17", features = ["recognize_text"] }

# iOS also supports Vision (same crate, same feature)
[target.'cfg(target_os = "ios")'.dependencies]
apple-vision = { version = "0.17", features = ["recognize_text"] }

# Windows: WinRT OCR engine
[target.'cfg(target_os = "windows")'.dependencies]
win_ocr = "0.1"
```

> [!NOTE]
> `apple-vision` compiles a thin Obj-C bridge at build time — it needs macOS SDK headers, which are already available in any normal macOS Rust toolchain. `win_ocr` wraps the `windows` crate and compiles only on Windows targets. Neither adds runtime binaries.

**New structs and command in `tauri/src/pdf.rs`:**

```rust
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct OcrPage {
    pub page_index: u16,
    pub text: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct OcrDocument {
    pub page_count: u16,
    pub pages: Vec<OcrPage>,
    pub engine: String,  // "apple-vision" | "windows-ocr" | "unavailable"
}

impl PdfEngine {
    /// Returns true if the PDF appears to be image-only (no embedded text).
    /// Checks up to `sample_pages` evenly-spaced pages.
    pub fn is_image_only(&self, path: &Path, sample_pages: u16) -> Result<bool, String> {
        let info = self.get_info(path)?;
        let total = info.page_count;
        if total == 0 { return Ok(false); }
        let step = (total / sample_pages.min(total)).max(1);
        let mut empty = 0u16;
        let mut checked = 0u16;
        let mut idx = 0u16;
        while idx < total {
            let spans = self.get_page_text(path, idx)?;
            let combined: String = spans.iter().map(|s| s.text.as_str()).collect();
            if combined.trim().is_empty() { empty += 1; }
            checked += 1;
            idx += step;
        }
        Ok(checked > 0 && (empty as f32 / checked as f32) >= 0.8)
    }

    /// Renders every page as a high-DPI PNG, runs platform OCR, returns text per page.
    /// Returns `OcrDocument { engine: "unavailable" }` on unsupported platforms.
    pub fn ocr_all_pages(&self, path: &Path) -> Result<OcrDocument, String> {
        let info = self.get_info(path)?;
        let page_count = info.page_count;

        #[cfg(any(target_os = "macos", target_os = "ios", target_os = "windows"))]
        {
            let mut pages = Vec::with_capacity(page_count as usize);
            let tmp_dir = std::env::temp_dir();

            for idx in 0..page_count {
                // Render at 2.5× scale (~180 DPI) for good OCR accuracy
                let png_bytes = self.render_page_png(path, idx, 2.5)?;

                // Write to temp PNG (platform OCR APIs take a file path)
                let tmp_path = tmp_dir.join(format!("cd_ocr_{idx}.png"));
                std::fs::write(&tmp_path, &png_bytes)
                    .map_err(|e| format!("Failed to write OCR temp file: {e}"))?;

                let text = platform_ocr(&tmp_path.to_string_lossy())?;
                let _ = std::fs::remove_file(&tmp_path); // clean up immediately

                pages.push(OcrPage { page_index: idx, text });
            }

            let engine = if cfg!(target_os = "macos") || cfg!(target_os = "ios") {
                "apple-vision"
            } else {
                "windows-ocr"
            };

            return Ok(OcrDocument {
                page_count,
                pages,
                engine: engine.to_string(),
            });
        }

        // Unsupported platform (Linux, etc.)
        #[allow(unreachable_code)]
        Ok(OcrDocument {
            page_count,
            pages: vec![],
            engine: "unavailable".to_string(),
        })
    }

    /// Renders a single page to raw PNG bytes at the given scale.
    /// Extracted from render_page_jpeg so it can be reused without JPEG lossy compression.
    fn render_page_png(&self, path: &Path, page_index: u16, scale: f32) -> Result<Vec<u8>, String> {
        let rgb = self.with_document(path, |doc| {
            let page = doc.pages().get(page_index)
                .map_err(|e| format!("Page {page_index} out of bounds: {e}"))?;
            render_page_to_rgb_image(&page, scale)
        })?;
        let mut buf = Vec::new();
        image::DynamicImage::ImageRgb8(rgb)
            .write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Png)
            .map_err(|e| format!("PNG encode failed: {e}"))?;
        Ok(buf)
    }
}

// ── Platform OCR dispatch ────────────────────────────────────────────────────

#[cfg(any(target_os = "macos", target_os = "ios"))]
fn platform_ocr(image_path: &str) -> Result<String, String> {
    use apple_vision::prelude::*;
    let recognizer = TextRecognizer::new()
        .with_recognition_level(RecognitionLevel::Accurate)
        .with_language_correction(true);
    let observations = recognizer
        .recognize_in_path(image_path)
        .map_err(|e| e.to_string())?;
    let text = observations
        .iter()
        .map(|o| o.text.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    Ok(text)
}

#[cfg(target_os = "windows")]
fn platform_ocr(image_path: &str) -> Result<String, String> {
    win_ocr::ocr(image_path).map_err(|e| e.to_string())
}

// ── Tauri IPC command ────────────────────────────────────────────────────────

#[tauri::command]
pub async fn pdf_ocr_all_pages(
    app: tauri::AppHandle,
    state: tauri::State<'_, PdfEngineState>,
    path: String,
) -> Result<OcrDocument, String> {
    let engine = engine_from_state(&state)?;
    let resolved = resolve_pdf_path(&app, &path);
    tauri::async_runtime::spawn_blocking(move || engine.ocr_all_pages(&resolved))
        .await
        .map_err(|e| format!("OCR task failed: {e}"))?
}

#[tauri::command]
pub async fn pdf_is_image_only(
    app: tauri::AppHandle,
    state: tauri::State<'_, PdfEngineState>,
    path: String,
) -> Result<bool, String> {
    let engine = engine_from_state(&state)?;
    let resolved = resolve_pdf_path(&app, &path);
    tauri::async_runtime::spawn_blocking(move || engine.is_image_only(&resolved, 5))
        .await
        .map_err(|e| format!("is_image_only task failed: {e}"))?
}
```

> [!IMPORTANT]
> The `image` crate in `Cargo.toml` currently has `features = ["jpeg", "png"]` — **`png` is already enabled**, so `render_page_png` compiles with zero extra dependencies.

**Register new commands in `lib.rs`:**

```rust
pdf::pdf_ocr_all_pages,
pdf::pdf_is_image_only,
```

### 12.5 Frontend Integration

Update the builder's Tauri PDF extraction path to detect image-only PDFs and trigger OCR transparently:

```typescript
// app/src/lib/tauri/pdfExtract.ts
import { invoke } from '@tauri-apps/api/core';

export interface ExtractedDocument {
  page_count: number;
  pages: { page_index: number; text: string }[];
}

export interface OcrDocument extends ExtractedDocument {
  engine: 'apple-vision' | 'windows-ocr' | 'unavailable';
}

export async function extractPdfWithFallback(path: string): Promise<{
  pages: { page_index: number; text: string }[];
  usedOcr: boolean;
  ocrEngine?: string;
}> {
  // Step 1: try native PDFium text extraction
  const doc = await invoke<ExtractedDocument>('pdf_extract_all_text', { path });
  const hasText = doc.pages.some(p => p.text.trim().length > 20);

  if (hasText) {
    return { pages: doc.pages, usedOcr: false };
  }

  // Step 2: no embedded text → try platform OCR
  const ocrDoc = await invoke<OcrDocument>('pdf_ocr_all_pages', { path });

  if (ocrDoc.engine === 'unavailable') {
    // Linux or other unsupported: return empty and let the user know
    return { pages: [], usedOcr: false, ocrEngine: 'unavailable' };
  }

  return {
    pages: ocrDoc.pages,
    usedOcr: true,
    ocrEngine: ocrDoc.engine,
  };
}
```

**Builder page — surface OCR status to the user:**

```svelte
<!-- In the upload step, after aiAnalysisStep text -->
{#if ocrUsed}
  <div class="flex items-center space-x-1.5 text-xs text-amber-700 dark:text-amber-300 mt-1">
    <ScanLine class="w-3.5 h-3.5" />
    <span>Scanned PDF detected — text extracted via {ocrEngine === 'apple-vision' ? 'Apple Vision' : 'Windows OCR'}.</span>
  </div>
{/if}
{#if ocrEngine === 'unavailable'}
  <div class="text-xs text-red-600 mt-1">
    This PDF appears to be a scanned image and OCR is not available on this platform.
    Consider converting the PDF to a text-selectable format first.
  </div>
{/if}
```

### 12.6 OCR Quality Considerations

| Concern | Mitigation |
|---------|-----------|
| **DPI too low** — OCR misreads characters | Render at `scale=2.5` (≈180 DPI at 72 pt/inch base). For very dense text, allow up to `scale=4.0` (288 DPI). |
| **Temp file leakage** on crash | Use `scopeguard` or a RAII wrapper; alternatively use `std::fs::remove_file` in a `defer`-style closure. |
| **Large PDFs slow to OCR** | OCR is only triggered when the user explicitly uploads a document to the builder, not during normal app usage. Show a progress indicator per page. Consider caching OCR results alongside the PDF in `locker_docs/`. |
| **Multi-language PDFs** | `apple-vision` auto-detects language from the image. `win_ocr` defaults to the system language but accepts explicit `Language` structs — expose a language hint field in the builder UI if needed. |
| **Windows language pack missing** | `OcrEngine.IsLanguageSupported()` / `win_ocr` returns an error gracefully; surface a user-readable message pointing to Windows Language Settings. |
| **iOS** | `apple-vision` works on iOS 13+ (same crate, same API). The builder's upload flow on iOS goes through the same Tauri IPC path since `pdf_ocr_all_pages` is registered universally. |

### 12.7 Updated Implementation Sequence

Add this as **Phase 0** (before the PDF quality fix in Phase 1, since it informs whether we have text to extract at all):

```
Phase 0 — Platform OCR for Scanned PDFs
  [0a] Add apple-vision (macOS/iOS) and win_ocr (Windows) deps to Cargo.toml
       under cfg-gated target sections
  [0b] Add render_page_png() helper to PdfEngine
  [0c] Add platform_ocr() dispatch fn (cfg-gated)
  [0d] Add is_image_only() detection method
  [0e] Add ocr_all_pages() method to PdfEngine
  [0f] Add pdf_ocr_all_pages and pdf_is_image_only Tauri commands
  [0g] Register both commands in lib.rs invoke_handler
  [0h] Add extractPdfWithFallback() in app/src/lib/tauri/pdfExtract.ts
  [0i] Builder page: use extractPdfWithFallback(); show OCR status indicator
```

---

## 11. Files to Create or Modify

| File | Change |
|------|--------|
| `tauri/Cargo.toml` | Add `apple-vision` (macOS/iOS targets) and `win_ocr` (Windows target) under cfg-gated `[target.*.dependencies]` sections |
| `tauri/src/pdf.rs` | Add `ExtractedPage`, `ExtractedDocument`, `OcrPage`, `OcrDocument`; add `PdfEngine::extract_all_text`, `is_image_only`, `ocr_all_pages`, `render_page_png`; add `platform_ocr()` dispatch; add `pdf_extract_all_text`, `pdf_ocr_all_pages`, `pdf_is_image_only` commands |
| `tauri/src/lib.rs` | Register all new pdf commands in invoke handler |
| `app/src/lib/tauri/pdfExtract.ts` | New: `extractPdfWithFallback()` — detects image-only PDF and triggers OCR |
| `app/src/lib/tauri/tempFile.ts` | New: write temp file for Tauri IPC |
| `app/src/lib/server/pdfText.ts` | Keep as-is for web/dev fallback |
| `app/src/lib/server/builder/epubExtractor.ts` | New: EPUB → chapters + raw text |
| `app/src/lib/server/builder/chunker.ts` | New: adaptive chunking with page map |
| `app/src/lib/server/builder/architect.ts` | New: structured prompt builder |
| `app/src/lib/server/api.ts` | Extend `/api/builder/propose` handler; add `/api/builder/enrich`; update `FALLBACK_COURSE_BUILDER_PROMPT`; update `normalizeProposal` |
| `app/src/routes/builder/+page.svelte` | Accept `.epub`; call `extractPdfWithFallback()` for Tauri; display OCR status indicator; display `externalRefs` in lesson card |
| `app/src/lib/server/api.builder.test.ts` | Add tests for EPUB, page-structured input, OCR-flagged proposals, enriched proposal schema |
