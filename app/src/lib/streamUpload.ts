import { getApiBaseUrl } from './api';

export interface StreamUploadProgressMessage {
  type?: 'progress' | 'complete' | 'error' | string;
  percent?: number;
  current?: number;
  total?: number;
  status?: string;
  message?: string;
  success?: boolean;
  [key: string]: unknown;
}

export interface StreamUploadOptions<TMessage = StreamUploadProgressMessage> {
  /** Target endpoint (absolute or relative, e.g. '/api/backup/import?stream=true') */
  url: string;
  /** Request body to stream (FormData, Blob, File, or ArrayBuffer) */
  body: FormData | Blob | File | ArrayBuffer;
  /** Optional HTTP headers */
  headers?: Record<string, string>;
  /** Called during the file upload phase (percent from 0 to 100, loaded bytes, total bytes) */
  onUploadProgress?: (percent: number, loaded: number, total: number) => void;
  /** Called for each parsed JSON line streamed back from the server */
  onMessage?: (message: TMessage) => void;
  /** Optional AbortSignal to cancel the upload or streaming response */
  signal?: AbortSignal;
}

/**
 * Resolves relative URLs (e.g. '/api/...') to the active desktop sidecar port
 * when running inside Tauri desktop, while leaving absolute URLs intact.
 */
export function resolveUploadUrl(rawUrl: string): string {
  const trimmed = (rawUrl || '').trim();
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  if (trimmed.startsWith('/')) {
    const base = getApiBaseUrl();
    return base ? `${base}${trimmed}` : trimmed;
  }
  return trimmed;
}

/**
 * Streams high-payload file uploads (FormData/Blob) with real-time XHR upload progress
 * and line-delimited JSON (NDJSON) streaming response parsing.
 *
 * Designed for Tauri desktop environments (WebKitGTK on Linux, WKWebView on macOS,
 * WebView2 on Windows) to bypass IPC buffer bottlenecks and UI thread freezes,
 * while safely buffering partial newline-delimited chunks.
 */
export function streamUpload<TResult = any, TMessage = StreamUploadProgressMessage>(
  options: StreamUploadOptions<TMessage>
): Promise<TResult> {
  const { url, body, headers, onUploadProgress, onMessage, signal } = options;

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let lastIndex = 0;
    let completedResult: TResult | undefined;
    let streamError: string | undefined;

    const targetUrl = resolveUploadUrl(url);
    xhr.open('POST', targetUrl, true);

    // Default to accepting streaming NDJSON unless caller explicitly provided Accept header
    const hasCustomAccept = headers && Object.keys(headers).some((k) => k.toLowerCase() === 'accept');
    if (!hasCustomAccept) {
      xhr.setRequestHeader('Accept', 'application/x-ndjson, application/json;q=0.9, */*;q=0.8');
    }

    if (headers) {
      for (const [key, value] of Object.entries(headers)) {
        xhr.setRequestHeader(key, value);
      }
    }

    let cleanupSignal: (() => void) | undefined;
    if (signal) {
      if (signal.aborted) {
        xhr.abort();
        return reject(new DOMException('Upload aborted', 'AbortError'));
      }
      const onAbort = () => {
        xhr.abort();
      };
      signal.addEventListener('abort', onAbort, { once: true });
      cleanupSignal = () => signal.removeEventListener('abort', onAbort);
    }

    const settle = () => {
      cleanupSignal?.();
      cleanupSignal = undefined;
    };

    // 1. Track Upload Progress
    if (onUploadProgress) {
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && event.total > 0) {
          const percent = Math.min(100, Math.max(0, Math.round((event.loaded / event.total) * 100)));
          onUploadProgress(percent, event.loaded, event.total);
        } else {
          onUploadProgress(0, event.loaded, event.total || 0);
        }
      };
    }

    // Helper to safely parse incoming NDJSON lines with partial chunk buffering
    const processChunk = (chunk: string, isFinal = false) => {
      const lastNewline = chunk.lastIndexOf('\n');

      // If not final and there is no complete newline in this chunk, buffer it until more arrives
      if (!isFinal && lastNewline === -1) {
        return;
      }

      // If final, process everything up to end of chunk; otherwise, up to the last complete newline
      const textToProcess = isFinal ? chunk : chunk.slice(0, lastNewline);
      const lines = textToProcess.split('\n');

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed);
          onMessage?.(msg);
          if (msg && typeof msg === 'object') {
            if (msg.type === 'complete') {
              completedResult = msg as unknown as TResult;
            } else if (msg.type === 'error' || msg.success === false) {
              streamError = msg.message || 'Stream error';
            }
          }
        } catch {
          // Ignore incomplete or non-JSON commentary lines
        }
      }

      if (!isFinal) {
        lastIndex += lastNewline + 1;
      } else {
        lastIndex += chunk.length;
      }
    };

    // 2. Track Streamed NDJSON Response
    xhr.onprogress = () => {
      const currentChunk = xhr.responseText.slice(lastIndex);
      if (currentChunk.includes('\n')) {
        processChunk(currentChunk, false);
      }
    };

    // 3. Handle Completion
    xhr.onload = () => {
      settle();
      const remaining = xhr.responseText.slice(lastIndex);
      if (remaining) {
        processChunk(remaining, true);
      }

      if (xhr.status >= 200 && xhr.status < 300 && !streamError) {
        if (completedResult === undefined) {
          const text = xhr.responseText.trim();
          if (text) {
            try {
              completedResult = JSON.parse(text) as TResult;
            } catch {
              completedResult = text as unknown as TResult;
            }
          }
        }
        resolve(completedResult as TResult);
      } else {
        let err = streamError;
        if (!err) {
          try {
            const parsed = JSON.parse(xhr.responseText);
            err = parsed.message || parsed.error || parsed.detail;
          } catch {}
        }
        if (!err) {
          err = `Request failed (HTTP ${xhr.status}): ${xhr.statusText || 'Server error'}`;
        }
        reject(new Error(err));
      }
    };

    xhr.onerror = () => {
      settle();
      reject(new Error('Network error occurred during upload'));
    };

    xhr.onabort = () => {
      settle();
      reject(new DOMException('Upload aborted', 'AbortError'));
    };

    xhr.send(body as XMLHttpRequestBodyInit);
  });
}
