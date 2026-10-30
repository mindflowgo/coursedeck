import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { extractTextFromPdf } from './pdfText';

describe('extractTextFromPdf', () => {
  it('extracts text from a real PDF buffer without DOMMatrix errors', async () => {
    const samplePath = path.resolve('data.old/courses/clu3m/assets/locker_docs/clu3m_01_glossary.pdf');
    if (!fs.existsSync(samplePath)) {
      return; // Skip if test fixture is missing
    }
    const buf = fs.readFileSync(samplePath);
    const text = await extractTextFromPdf(buf);
    expect(typeof text).toBe('string');
    expect(text.length).toBeGreaterThan(100);
    expect(text.toLowerCase()).toContain('law');
  });

  it('handles empty or invalid PDF buffers with an error', async () => {
    const invalidBuf = Buffer.from('not a pdf');
    expect(extractTextFromPdf(invalidBuf)).rejects.toThrow();
  });
});
