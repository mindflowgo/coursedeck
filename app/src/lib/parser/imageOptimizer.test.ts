import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  optimizeCourseImages,
  optimizeImageBuffer,
  MAX_IMAGE_WIDTH,
  SKIP_SIZE_THRESHOLD
} from './imageOptimizer';

describe('imageOptimizer', () => {
  let tmpDir: string;
  let imgDir: string;
  const basePngPath = path.resolve(process.cwd(), 'tauri/icons/icon.png');
  const basePng = fs.readFileSync(basePngPath);

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'img-opt-test-'));
    imgDir = path.join(tmpDir, 'assets', 'img');
    fs.mkdirSync(imgDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  async function createTestImage(
    filename: string,
    width: number,
    format: 'png' | 'jpeg' = 'png'
  ): Promise<string> {
    const filePath = path.join(imgDir, filename);
    const BunAny = globalThis as any;
    const ImageCtor = BunAny.Bun ? BunAny.Bun.Image : null;
    if (!ImageCtor) {
      throw new Error('Bun.Image required for tests');
    }
    const img = new ImageCtor(basePng).resize(width);
    const buf = format === 'jpeg' ? await img.jpeg().buffer() : await img.png().buffer();
    fs.writeFileSync(filePath, buf);
    return filePath;
  }

  it('always reprocesses PNG images and converts them to .jpg', async () => {
    // Create a 500px wide PNG (<1024)
    await createTestImage('diagram.png', 500, 'png');

    // Create a markdown file referencing it
    fs.writeFileSync(path.join(tmpDir, 'lesson1.md'), '![Diagram](./assets/img/diagram.png)', 'utf8');
    // Create an HTML file referencing it
    fs.writeFileSync(path.join(tmpDir, '01-01.lesson.html'), '<p><img src="./assets/img/diagram.png" alt="Test"></p>', 'utf8');

    const summary = await optimizeCourseImages(tmpDir, { quality: 70 });
    expect(summary.converted).toBe(1);

    // diagram.png should be converted and deleted
    expect(fs.existsSync(path.join(imgDir, 'diagram.png'))).toBe(false);
    expect(fs.existsSync(path.join(imgDir, 'diagram.jpg'))).toBe(true);

    // Markdown reference updated
    const mdContent = fs.readFileSync(path.join(tmpDir, 'lesson1.md'), 'utf8');
    expect(mdContent).toContain('./assets/img/diagram.jpg');
    expect(mdContent).not.toContain('diagram.png');

    // HTML reference updated
    const htmlContent = fs.readFileSync(path.join(tmpDir, '01-01.lesson.html'), 'utf8');
    expect(htmlContent).toContain('./assets/img/diagram.jpg');
    expect(htmlContent).not.toContain('diagram.png');
  });

  it('clamps width to 1024 when width > 1024 without upscaling smaller images', async () => {
    // Create a 2048px wide PNG
    await createTestImage('large.png', 2048, 'png');

    await optimizeCourseImages(tmpDir, { quality: 70 });

    const targetPath = path.join(imgDir, 'large.jpg');
    expect(fs.existsSync(targetPath)).toBe(true);

    const BunAny = globalThis as any;
    const ImageCtor = BunAny.Bun.Image;
    const meta = await new ImageCtor(fs.readFileSync(targetPath)).metadata();
    expect(meta.width).toBe(1024);
  });

  it('skips JPEG when width < 1024 AND size < 20KB', async () => {
    // Create a small 200px wide JPEG
    await createTestImage('small.jpg', 200, 'jpeg');
    const fileSize = fs.statSync(path.join(imgDir, 'small.jpg')).size;
    expect(fileSize).toBeLessThan(SKIP_SIZE_THRESHOLD);

    const summary = await optimizeCourseImages(tmpDir, { quality: 70 });
    expect(summary.converted).toBe(0);
    expect(fs.existsSync(path.join(imgDir, 'small.jpg'))).toBe(true);
  });

  it('reprocesses JPEG when size >= 20KB or width >= 1024', async () => {
    // Create an oversized 1200px wide JPEG
    await createTestImage('hero.jpg', 1200, 'jpeg');

    const summary = await optimizeCourseImages(tmpDir, { quality: 70 });
    expect(summary.converted).toBe(1);

    const BunAny = globalThis as any;
    const ImageCtor = BunAny.Bun.Image;
    const meta = await new ImageCtor(fs.readFileSync(path.join(imgDir, 'hero.jpg'))).metadata();
    expect(meta.width).toBe(1024);
  });

  it('optimizes single image buffer via optimizeImageBuffer', async () => {
    const pngPath = await createTestImage('test_single.png', 500, 'png');
    const buffer = fs.readFileSync(pngPath);

    const result = await optimizeImageBuffer(buffer, 'test_single.png', { quality: 70 });
    expect(result.converted).toBe(true);
    expect(result.filename).toBe('test_single.jpg');

    const BunAny = globalThis as any;
    const ImageCtor = BunAny.Bun.Image;
    const meta = await new ImageCtor(result.buffer).metadata();
    expect(meta.format).toBe('jpeg');
  });
});
