import { describe, it, expect } from 'bun:test';
import { extractImageFile } from './imagePaste';

describe('imagePaste extractImageFile', () => {
  it('returns null if dataTransfer is null', () => {
    expect(extractImageFile(null)).toBeNull();
  });

  it('extracts image from clipboardData.items', () => {
    const fakeBlob = new Blob(['dummy'], { type: 'image/png' });
    const fakeFile = new File([fakeBlob], 'screenshot.png', { type: 'image/png' });

    const mockDataTransfer = {
      items: [
        {
          kind: 'string',
          type: 'text/plain',
          getAsFile: () => null
        },
        {
          kind: 'file',
          type: 'image/png',
          getAsFile: () => fakeFile
        }
      ],
      files: []
    } as unknown as DataTransfer;

    const extracted = extractImageFile(mockDataTransfer);
    expect(extracted).toBe(fakeFile);
  });

  it('extracts image from clipboardData.files when items is empty or not matching', () => {
    const fakeFile = new File(['dummy'], 'photo.jpg', { type: 'image/jpeg' });

    const mockDataTransfer = {
      items: [],
      files: [fakeFile]
    } as unknown as DataTransfer;

    const extracted = extractImageFile(mockDataTransfer);
    expect(extracted).toBe(fakeFile);
  });

  it('extracts image by filename extension when MIME type is missing', () => {
    const fakeFile = new File(['dummy'], 'diagram.png', { type: '' });

    const mockDataTransfer = {
      items: [],
      files: [fakeFile]
    } as unknown as DataTransfer;

    const extracted = extractImageFile(mockDataTransfer);
    expect(extracted).toBe(fakeFile);
  });

  it('returns null if no image items or files are present', () => {
    const textFile = new File(['dummy text'], 'notes.txt', { type: 'text/plain' });

    const mockDataTransfer = {
      items: [
        {
          kind: 'file',
          type: 'text/plain',
          getAsFile: () => textFile
        }
      ],
      files: [textFile]
    } as unknown as DataTransfer;

    const extracted = extractImageFile(mockDataTransfer);
    expect(extracted).toBeNull();
  });
});
