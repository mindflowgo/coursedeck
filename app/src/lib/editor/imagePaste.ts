import { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { apiFetch } from '$lib/api';
import { compressImageToJpeg, generateLockerDocFilename } from './imageProcessor';

export interface ImagePasteOptions {
  courseId: () => string;
  lessonId: () => string;
  onError?: (err: Error) => void;
}

/**
 * Extracts the first image File/Blob from clipboard data or drag event dataTransfer.
 * Supports:
 * - Bitmap screenshots from clipboard (Mac Cmd+Shift+4, Win+Shift+S, Snipping Tool)
 * - Copied image files from Finder / File Explorer
 * - Drag and drop of image files
 */
export function extractImageFile(data: DataTransfer | null): File | null {
  if (!data) return null;

  // 1. Check items (preferred for clipboard screenshots and modern browsers)
  if (data.items && data.items.length > 0) {
    for (let i = 0; i < data.items.length; i++) {
      const item = data.items[i];
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) return file;
      }
    }
  }

  // 2. Check files list (drag & drop or copied files from Explorer / Finder)
  if (data.files && data.files.length > 0) {
    for (let i = 0; i < data.files.length; i++) {
      const file = data.files[i];
      if (file.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|bmp|svg)$/i.test(file.name)) {
        return file;
      }
    }
  }

  return null;
}

async function handleImageUpload(
  view: EditorView,
  imageFile: File | Blob,
  insertPos: number,
  insertTo: number,
  options: ImagePasteOptions
) {
  const courseId = options.courseId();
  if (!courseId) {
    console.warn('Cannot upload image: courseId is missing');
    return;
  }

  const lessonId = options.lessonId();
  const filename = generateLockerDocFilename(lessonId);
  const placeholder = `![Uploading ${filename}...]()`;

  // Insert placeholder at caret/selection
  view.dispatch({
    changes: { from: insertPos, to: insertTo, insert: placeholder },
    selection: { anchor: insertPos + placeholder.length }
  });

  try {
    // Re-encode to compact JPEG with 70% quality (per user specification)
    const jpegBlob = await compressImageToJpeg(imageFile, 0.7);

    const formData = new FormData();
    formData.append('file', jpegBlob, filename);

    const res = await apiFetch(`/api/courses/${encodeURIComponent(courseId)}/locker-docs`, {
      method: 'POST',
      body: formData
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || `Upload failed with HTTP ${res.status}`);
    }

    const data = await res.json();
    const savedName = data.file?.filename || filename;
    const markdown = `![image](/assets/locker_docs/${savedName})`;

    // Locate the placeholder in the document (it may have shifted if user typed while uploading)
    const docString = view.state.doc.toString();
    const idx = docString.indexOf(placeholder);
    if (idx !== -1) {
      view.dispatch({
        changes: { from: idx, to: idx + placeholder.length, insert: markdown },
        selection: { anchor: idx + markdown.length }
      });
    }
  } catch (err) {
    console.error('Failed to upload pasted image:', err);
    // Remove placeholder on error
    const docString = view.state.doc.toString();
    const idx = docString.indexOf(placeholder);
    if (idx !== -1) {
      view.dispatch({
        changes: { from: idx, to: idx + placeholder.length, insert: '' }
      });
    }

    const error = err instanceof Error ? err : new Error(String(err));
    if (options.onError) {
      options.onError(error);
    } else {
      alert(`Failed to save image to locker_docs: ${error.message}`);
    }
  }
}

/**
 * CodeMirror extension enabling paste and drag-drop of images into the editor.
 * Automatically saves to assets/locker_docs/ and inserts the Markdown image link.
 */
export function imagePasteHandler(options: ImagePasteOptions): Extension {
  return EditorView.domEventHandlers({
    paste(event: ClipboardEvent, view: EditorView) {
      const imageFile = extractImageFile(event.clipboardData);
      if (!imageFile) return false;

      event.preventDefault();
      const { from, to } = view.state.selection.main;
      handleImageUpload(view, imageFile, from, to, options);
      return true;
    },

    dragover(event: DragEvent) {
      const types = event.dataTransfer?.types;
      if (types && (Array.from(types).includes('Files') || Array.from(types).includes('application/x-moz-file'))) {
        event.preventDefault();
        if (event.dataTransfer) {
          event.dataTransfer.dropEffect = 'copy';
        }
        return true;
      }
      return false;
    },

    drop(event: DragEvent, view: EditorView) {
      const imageFile = extractImageFile(event.dataTransfer);
      if (!imageFile) return false;

      event.preventDefault();
      const coords = { x: event.clientX, y: event.clientY };
      const dropPos = view.posAtCoords(coords);
      const insertPos = dropPos !== null ? dropPos : view.state.selection.main.from;
      handleImageUpload(view, imageFile, insertPos, insertPos, options);
      return true;
    }
  });
}
