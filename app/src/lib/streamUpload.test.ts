import { describe, expect, it, beforeEach } from 'bun:test';
import { streamUpload, resolveUploadUrl, type StreamUploadProgressMessage } from './streamUpload';

// Mock XMLHttpRequest for unit tests
class MockXMLHttpRequest {
  static instances: MockXMLHttpRequest[] = [];

  url = '';
  method = '';
  headers: Record<string, string> = {};
  responseText = '';
  status = 200;
  statusText = 'OK';
  upload = {
    onprogress: null as ((e: any) => void) | null
  };
  onprogress: (() => void) | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  sentBody: any = null;
  aborted = false;

  constructor() {
    MockXMLHttpRequest.instances.push(this);
  }

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(key: string, value: string) {
    this.headers[key] = value;
  }

  abort() {
    this.aborted = true;
    if (this.onabort) this.onabort();
  }

  send(body: any) {
    this.sentBody = body;
  }

  // Test helpers to simulate network chunks
  simulateUploadProgress(loaded: number, total: number) {
    if (this.upload.onprogress) {
      this.upload.onprogress({
        lengthComputable: total > 0,
        loaded,
        total
      });
    }
  }

  simulateResponseChunk(chunk: string) {
    this.responseText += chunk;
    if (this.onprogress) {
      this.onprogress();
    }
  }

  simulateCompletion(status = 200, statusText = 'OK') {
    this.status = status;
    this.statusText = statusText;
    if (this.onload) {
      this.onload();
    }
  }

  simulateError() {
    if (this.onerror) {
      this.onerror();
    }
  }
}

describe('streamUpload', () => {
  let originalXHR: any;

  beforeEach(() => {
    MockXMLHttpRequest.instances = [];
    originalXHR = (globalThis as any).XMLHttpRequest;
    (globalThis as any).XMLHttpRequest = MockXMLHttpRequest;
  });

  it('resolves relative URLs and preserves absolute URLs', () => {
    expect(resolveUploadUrl('http://127.0.0.1:3182/api/backup/import')).toBe('http://127.0.0.1:3182/api/backup/import');
    expect(resolveUploadUrl('https://example.com/api/upload')).toBe('https://example.com/api/upload');
    expect(resolveUploadUrl('/api/backup/import')).toContain('/api/backup/import');
  });

  it('tracks upload progress and safely buffers partial NDJSON lines', async () => {
    const uploadProgress: number[] = [];
    const receivedMessages: StreamUploadProgressMessage[] = [];

    const uploadPromise = streamUpload({
      url: '/api/backup/import?stream=true',
      body: new FormData(),
      onUploadProgress: (pct) => uploadProgress.push(pct),
      onMessage: (msg) => receivedMessages.push(msg)
    });

    const xhr = MockXMLHttpRequest.instances[0];
    expect(xhr).toBeDefined();
    expect(xhr.method).toBe('POST');
    expect(xhr.headers['Accept']).toContain('application/x-ndjson');

    // Simulate upload progress
    xhr.simulateUploadProgress(50, 100);
    xhr.simulateUploadProgress(100, 100);
    expect(uploadProgress).toEqual([50, 100]);

    // Simulate partial streaming chunks
    // Chunk 1: One complete line and one split line
    xhr.simulateResponseChunk('{"type":"progress","current":1,"total":3,"percent":33}\n{"type":"prog');
    expect(receivedMessages.length).toBe(1);
    expect(receivedMessages[0].current).toBe(1);

    // Chunk 2: Completion of the split line and start of another split line
    xhr.simulateResponseChunk('ress","current":2,"total":3,"percent":66}\n{"type":"comp');
    expect(receivedMessages.length).toBe(2);
    expect(receivedMessages[1].current).toBe(2);

    // Chunk 3: Completion of final complete message
    xhr.simulateResponseChunk('lete","message":"Restored successfully","coursesRestored":2}\n');
    expect(receivedMessages.length).toBe(3);
    expect(receivedMessages[2].type).toBe('complete');

    xhr.simulateCompletion(200);

    const result = await uploadPromise;
    expect(result.type).toBe('complete');
    expect(result.message).toBe('Restored successfully');
    expect(result.coursesRestored).toBe(2);
  });

  it('handles single-shot JSON response when streaming is not used', async () => {
    const uploadPromise = streamUpload({
      url: '/api/backup/import',
      body: new Blob(['dummy zip bytes']),
      headers: { 'X-Custom-Header': 'test' }
    });

    const xhr = MockXMLHttpRequest.instances[0];
    expect(xhr.headers['X-Custom-Header']).toBe('test');

    xhr.responseText = JSON.stringify({ success: true, count: 42 });
    xhr.simulateCompletion(200);

    const result = await uploadPromise;
    expect(result.success).toBe(true);
    expect(result.count).toBe(42);
  });

  it('rejects when server emits an error message line in stream', async () => {
    const uploadPromise = streamUpload({
      url: '/api/backup/import?stream=true',
      body: new FormData()
    });

    const xhr = MockXMLHttpRequest.instances[0];
    xhr.simulateResponseChunk('{"type":"error","message":"Archive is corrupt or password protected"}\n');
    xhr.simulateCompletion(200);

    expect(uploadPromise).rejects.toThrow('Archive is corrupt or password protected');
  });

  it('rejects on HTTP error status with server error message', async () => {
    const uploadPromise = streamUpload({
      url: '/api/backup/import',
      body: new FormData()
    });

    const xhr = MockXMLHttpRequest.instances[0];
    xhr.responseText = JSON.stringify({ message: 'A .zip backup file is required' });
    xhr.simulateCompletion(400, 'Bad Request');

    expect(uploadPromise).rejects.toThrow('A .zip backup file is required');
  });

  it('aborts upload when AbortSignal triggers', async () => {
    const controller = new AbortController();

    const uploadPromise = streamUpload({
      url: '/api/backup/import',
      body: new FormData(),
      signal: controller.signal
    });

    const xhr = MockXMLHttpRequest.instances[0];
    controller.abort();

    expect(xhr.aborted).toBe(true);
    expect(uploadPromise).rejects.toThrow('Upload aborted');
  });

  it('rejects immediately if AbortSignal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const uploadPromise = streamUpload({
      url: '/api/backup/import',
      body: new FormData(),
      signal: controller.signal
    });

    expect(uploadPromise).rejects.toThrow('Upload aborted');
  });

  it('rejects on network error', async () => {
    const uploadPromise = streamUpload({
      url: '/api/backup/import',
      body: new FormData()
    });

    const xhr = MockXMLHttpRequest.instances[0];
    xhr.simulateError();

    expect(uploadPromise).rejects.toThrow('Network error occurred during upload');
  });
});
