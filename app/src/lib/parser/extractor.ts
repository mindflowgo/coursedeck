import { unzipSync } from 'fflate';
import path from 'node:path';
import fs from 'node:fs';

export interface ExtractedLessonArchive {
  zipFilename: string; // Filename of source package (.zip, .mhtml, .html)
  packageFilename: string;
  htmlContent: string;
  htmlPathInZip?: string;
  title: string;
  unitNumber: number;
  lessonNumber: number;
  activityCode: string;
  isAssignment: boolean;
}

export interface IngestAssetResult {
  filename: string;
  category: 'img' | 'icons' | 'locker_docs' | 'other';
  destinationPath: string;
}

export class ArchiveExtractor {
  /**
   * Main extractor entrypoint: handles .zip, .mhtml, .mht, and .html lesson packages
   */
  static extract(
    filePath: string,
    assetsOutputDir: string
  ): ExtractedLessonArchive | null {
    if (!fs.existsSync(filePath)) {
      return null;
    }

    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.zip') {
      return this.extractZip(filePath, assetsOutputDir);
    } else if (ext === '.mhtml' || ext === '.mht') {
      return this.extractMhtml(filePath, assetsOutputDir);
    } else if (ext === '.html' || ext === '.htm') {
      return this.extractHtml(filePath, assetsOutputDir);
    }
    return null;
  }

  /**
   * Extract assets and lesson HTML inside a Zip file (SCORM package or browser-saved complete page)
   */
  static extractZip(
    zipPath: string,
    assetsOutputDir: string
  ): ExtractedLessonArchive | null {
    if (!fs.existsSync(zipPath)) {
      return null;
    }

    // fflate: pure-JS but the fastest zip decoder that still works inside
    // the compiled Bun sidecar binary (native libs like zip-bun do not).
    // Entries are inflated eagerly; SCORM packages fit comfortably in memory.
    const zipEntries: Array<{ entryName: string; isDirectory: boolean; getData(): Buffer }> = [];
    for (const [entryName, data] of Object.entries(unzipSync(new Uint8Array(fs.readFileSync(zipPath))))) {
      // Ignore macOS resource forks and metadata
      if (entryName.startsWith('__MACOSX') || path.basename(entryName).startsWith('._')) {
        continue;
      }
      const bytes = Buffer.from(data);
      zipEntries.push({
        entryName,
        isDirectory: entryName.endsWith('/'),
        getData: () => bytes
      });
    }
    const zipBasename = path.basename(zipPath);

    // Ensure asset directories exist
    fs.mkdirSync(path.join(assetsOutputDir, 'img'), { recursive: true });
    fs.mkdirSync(path.join(assetsOutputDir, 'icons'), { recursive: true });
    fs.mkdirSync(path.join(assetsOutputDir, 'locker_docs'), { recursive: true });

    const cleanZipName = zipBasename
      .replace(/\.(html\.zip|zip|mhtml|mht|html|htm)$/i, '')
      .toLowerCase();
    const isZipAssignment = /assign/i.test(zipBasename);
    const ulaMatch = zipBasename.match(/u(\d+)la(\d+)/i);
    const targetCode = ulaMatch ? `u${ulaMatch[1]}la${ulaMatch[2]}`.toLowerCase() : null;

    let bestHtmlEntry: { entryName: string; text: string; score: number } | null = null;

    for (const entry of zipEntries) {
      if (entry.isDirectory) continue;
      const entryName = entry.entryName;
      const filename = path.basename(entryName);
      const ext = path.extname(filename).toLowerCase();

      // Extract image assets (.jpg, .jpeg, .png, .webp, .gif)
      if (/\.(png|jpe?g|gif|webp)$/i.test(ext)) {
        const dest = path.join(assetsOutputDir, 'img', filename);
        if (!fs.existsSync(dest)) {
          fs.writeFileSync(dest, entry.getData());
        }
      }
      // Extract icon/diagram SVGs (.svg)
      else if (/\.svg$/i.test(ext)) {
        const dest = path.join(assetsOutputDir, 'icons', filename);
        if (!fs.existsSync(dest)) {
          fs.writeFileSync(dest, entry.getData());
        }
      }
      // Extract documents & PDFs
      else if (/\.(pdf|docx?|xlsx?|pptx?)$/i.test(ext)) {
        const dest = path.join(assetsOutputDir, 'locker_docs', filename);
        if (!fs.existsSync(dest)) {
          fs.writeFileSync(dest, entry.getData());
        }
      }

      // Check for HTML lesson candidates
      if (ext === '.html' || ext === '.htm') {
        const lowerName = entryName.toLowerCase();
        const lowerFilename = filename.toLowerCase();
        const entryStem = path.basename(lowerFilename, ext);
        const text = entry.getData().toString('utf8');

        let score = 0;

        // 1. Direct stem match (e.g. entry "gwl3o_u1la1.html" matches package "gwl3o_u1la1.html.zip")
        if (entryStem === cleanZipName) {
          score += 1000;
        }

        // 2. Unit/Lesson code match (e.g. "u1la1")
        if (targetCode) {
          if (entryStem.includes(targetCode) || lowerName.includes(targetCode)) {
            score += 500;
          } else if (/u\d+la\d+/i.test(lowerName)) {
            // Belongs to a completely different lesson code (e.g. u4la5 in a u1la1 package)
            score -= 800;
          }
        }

        // 3. Assignment vs Lesson folder preference
        if (isZipAssignment) {
          if (lowerName.includes('/assignments/') || lowerName.startsWith('assignments/')) {
            score += 400;
          }
          if (entryStem.includes('assign')) {
            score += 200;
          }
          if (lowerName.includes('/lessons/') || lowerName.startsWith('lessons/')) {
            score -= 200;
          }
        } else {
          // Regular lesson package: strongly prefer lessons/ folder over assignments/
          if (lowerName.includes('/lessons/') || lowerName.startsWith('lessons/')) {
            score += 400;
          }
          if (lowerName.includes('/assignments/') || lowerName.startsWith('assignments/')) {
            score -= 600;
          }
          if (entryStem.includes('assign')) {
            score -= 400;
          }
        }

        // 4. intermediate.html (Brightspace/SCORM embedded lesson content)
        if (entryStem === 'intermediate' || lowerName.includes('intermediate.html')) {
          score += 1500;
        }

        // 5. Penalize ancillary/sub-asset folders
        if (
          lowerName.includes('/locker_docs/') ||
          lowerName.includes('/alt/') ||
          lowerName.includes('/assets/') ||
          lowerName.includes('/dependencies/') ||
          lowerName.includes('/vendor/')
        ) {
          score -= 1000;
        }

        // 6. Content markers
        if (text.includes('ilcLearningGoals') || text.includes('mindsOn')) {
          score += 150;
        }
        if (text.includes('<section id="app_')) {
          score += 100;
        }

        if (!bestHtmlEntry || score > bestHtmlEntry.score) {
          bestHtmlEntry = { entryName, text, score };
        }
      }
    }

    if (!bestHtmlEntry) return null;

    const htmlContent = bestHtmlEntry.text;
    const htmlPathInZip = bestHtmlEntry.entryName;

    const meta = this.parseLessonMetadata(zipBasename, htmlContent);

    return {
      zipFilename: zipBasename,
      packageFilename: zipBasename,
      htmlContent,
      htmlPathInZip,
      title: meta.title,
      unitNumber: meta.unitNumber,
      lessonNumber: meta.lessonNumber,
      activityCode: meta.activityCode,
      isAssignment: meta.isAssignment
    };
  }

  /**
   * Extract assets and lesson HTML from a browser-saved Single File Web Archive (.mhtml / .mht)
   */
  static extractMhtml(
    mhtmlPath: string,
    assetsOutputDir: string
  ): ExtractedLessonArchive | null {
    if (!fs.existsSync(mhtmlPath)) {
      return null;
    }

    const mhtmlBasename = path.basename(mhtmlPath);
    const raw = fs.readFileSync(mhtmlPath, 'utf8');

    fs.mkdirSync(path.join(assetsOutputDir, 'img'), { recursive: true });
    fs.mkdirSync(path.join(assetsOutputDir, 'icons'), { recursive: true });
    fs.mkdirSync(path.join(assetsOutputDir, 'locker_docs'), { recursive: true });

    // Locate boundary
    const boundaryMatch = raw.match(/boundary="?([^"\r\n]+)"?/i);
    if (!boundaryMatch) return null;

    const boundary = boundaryMatch[1];
    const rawParts = raw.split('--' + boundary);

    let lessonHtml = '';
    let fallbackHtml = '';

    for (const rawPart of rawParts) {
      if (rawPart.trim() === '--' || !rawPart.trim()) continue;
      const headerEnd = rawPart.search(/\r?\n\r?\n/);
      if (headerEnd === -1) continue;

      const headerText = rawPart.slice(0, headerEnd);
      const body = rawPart.slice(headerEnd).replace(/^(\r?\n)+/, '');

      const headers: Record<string, string> = {};
      headerText.split(/\r?\n(?![ \t])/).forEach((line) => {
        const colon = line.indexOf(':');
        if (colon !== -1) {
          const k = line.slice(0, colon).trim().toLowerCase();
          const v = line.slice(colon + 1).trim();
          headers[k] = v;
        }
      });

      const ctype = (headers['content-type'] || '').toLowerCase();
      const cloc = headers['content-location'] || headers['snapshot-content-location'] || '';
      const encoding = (headers['content-transfer-encoding'] || '').toLowerCase();
      const filename = path.basename(cloc.split('?')[0]);

      // Extract image assets
      if (ctype.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg)$/i.test(filename)) {
        if (filename && filename !== '/' && filename.length > 2) {
          const isSvg = /\.svg$/i.test(filename) || ctype.includes('svg');
          const destDir = isSvg ? path.join(assetsOutputDir, 'icons') : path.join(assetsOutputDir, 'img');
          const dest = path.join(destDir, filename);
          if (!fs.existsSync(dest)) {
            const buf = encoding.includes('base64')
              ? Buffer.from(body.replace(/\s+/g, ''), 'base64')
              : Buffer.from(body, 'utf8');
            fs.writeFileSync(dest, buf);
          }
        }
      }

      // Extract document assets (.pdf, .docx, etc.)
      if (ctype.includes('pdf') || /\.(pdf|docx?|xlsx?)$/i.test(filename)) {
        if (filename && filename !== '/' && filename.length > 2) {
          const dest = path.join(assetsOutputDir, 'locker_docs', filename);
          if (!fs.existsSync(dest)) {
            const buf = encoding.includes('base64')
              ? Buffer.from(body.replace(/\s+/g, ''), 'base64')
              : Buffer.from(body, 'utf8');
            fs.writeFileSync(dest, buf);
          }
        }
      }

      // Extract HTML content
      if (ctype.includes('text/html')) {
        let decoded = body;
        if (encoding.includes('quoted-printable')) {
          decoded = this.decodeQuotedPrintable(body);
        } else if (encoding.includes('base64')) {
          decoded = Buffer.from(decoded.replace(/\s+/g, ''), 'base64').toString('utf8');
        }

        // Check if this part contains the actual lesson body
        if (
          cloc.includes('lessons/') ||
          cloc.includes('assignments/') ||
          cloc.includes('intermediate.html') ||
          decoded.includes('ilcLearningGoals') ||
          decoded.includes('mindsOn')
        ) {
          lessonHtml = decoded;
        } else if (!fallbackHtml && (decoded.includes('<body') || decoded.includes('<main'))) {
          fallbackHtml = decoded;
        }
      }
    }

    const htmlContent = lessonHtml || fallbackHtml;
    if (!htmlContent) return null;

    const meta = this.parseLessonMetadata(mhtmlBasename, htmlContent);

    return {
      zipFilename: mhtmlBasename,
      packageFilename: mhtmlBasename,
      htmlContent,
      htmlPathInZip: mhtmlBasename,
      title: meta.title,
      unitNumber: meta.unitNumber,
      lessonNumber: meta.lessonNumber,
      activityCode: meta.activityCode,
      isAssignment: meta.isAssignment
    };
  }

  /**
   * Extract assets and lesson HTML from standalone HTML file or HTML + companion folder
   */
  static extractHtml(
    htmlPath: string,
    assetsOutputDir: string
  ): ExtractedLessonArchive | null {
    if (!fs.existsSync(htmlPath)) return null;

    const htmlBasename = path.basename(htmlPath);
    const htmlContent = fs.readFileSync(htmlPath, 'utf8');

    fs.mkdirSync(path.join(assetsOutputDir, 'img'), { recursive: true });
    fs.mkdirSync(path.join(assetsOutputDir, 'icons'), { recursive: true });
    fs.mkdirSync(path.join(assetsOutputDir, 'locker_docs'), { recursive: true });

    // Look for companion folder: e.g. "Lesson 1.1_files" or "Lesson 1.1.files"
    const dir = path.dirname(htmlPath);
    const stem = htmlBasename.replace(/\.(html|htm)$/i, '');
    const companionDirs = [
      path.join(dir, `${stem}_files`),
      path.join(dir, `${stem}.files`),
      path.join(dir, 'assets')
    ];

    for (const compDir of companionDirs) {
      if (fs.existsSync(compDir) && fs.statSync(compDir).isDirectory()) {
        const files = fs.readdirSync(compDir);
        for (const file of files) {
          const filePath = path.join(compDir, file);
          if (fs.statSync(filePath).isDirectory()) continue;
          const ext = path.extname(file).toLowerCase();
          if (/\.(png|jpe?g|gif|webp)$/i.test(ext)) {
            const dest = path.join(assetsOutputDir, 'img', file);
            if (!fs.existsSync(dest)) fs.copyFileSync(filePath, dest);
          } else if (/\.svg$/i.test(ext)) {
            const dest = path.join(assetsOutputDir, 'icons', file);
            if (!fs.existsSync(dest)) fs.copyFileSync(filePath, dest);
          } else if (/\.(pdf|docx?|xlsx?)$/i.test(ext)) {
            const dest = path.join(assetsOutputDir, 'locker_docs', file);
            if (!fs.existsSync(dest)) fs.copyFileSync(filePath, dest);
          }
        }
      }
    }

    const meta = this.parseLessonMetadata(htmlBasename, htmlContent);

    return {
      zipFilename: htmlBasename,
      packageFilename: htmlBasename,
      htmlContent,
      htmlPathInZip: htmlBasename,
      title: meta.title,
      unitNumber: meta.unitNumber,
      lessonNumber: meta.lessonNumber,
      activityCode: meta.activityCode,
      isAssignment: meta.isAssignment
    };
  }

  /**
   * Helper to parse unit number, lesson number, activity code, and clean title from filename & HTML content
   */
  static parseLessonMetadata(
    filename: string,
    htmlContent: string = ''
  ): {
    unitNumber: number;
    lessonNumber: number;
    activityCode: string;
    isAssignment: boolean;
    title: string;
  } {
    let unitNumber = 1;
    let lessonNumber = 1;
    let activityCode = '';
    let isAssignment = /assign/i.test(filename);

    // 1. Try u1la2 in filename
    const ulaMatch = filename.match(/u(\d+)la(\d+)(?:_assign(\d+))?/i);
    if (ulaMatch) {
      unitNumber = parseInt(ulaMatch[1], 10);
      lessonNumber = parseInt(ulaMatch[2], 10);
      if (ulaMatch[3]) isAssignment = true;
      activityCode = filename.replace(/\.(html\.zip|zip|mhtml|mht|html|htm)$/i, '');
    } else {
      // 2. Try "Learning activity 1.2" in filename
      const laMatch = filename.match(
        /(?:learning\s*activity|activity|lesson|unit)\s*(\d+)[\._\s]+(\d+)/i
      );
      if (laMatch) {
        unitNumber = parseInt(laMatch[1], 10);
        lessonNumber = parseInt(laMatch[2], 10);
      } else {
        // 3. Try "1.2"
        const numMatch = filename.match(/(\d+)[\._](\d+)/);
        if (numMatch) {
          unitNumber = parseInt(numMatch[1], 10);
          lessonNumber = parseInt(numMatch[2], 10);
        }
      }
    }

    // 4. Check HTML content for activityCode or unit/lesson if not resolved
    if (!activityCode && htmlContent) {
      const codeMatch = htmlContent.match(
        /(?:lessons|assignments)\/([a-zA-Z0-9_]+_u(\d+)la(\d+))/i
      );
      if (codeMatch) {
        activityCode = codeMatch[1];
        if (!ulaMatch) {
          unitNumber = parseInt(codeMatch[2], 10);
          lessonNumber = parseInt(codeMatch[3], 10);
        }
      }
    }

    if (!activityCode) {
      activityCode = `u${unitNumber}la${lessonNumber}`;
    }

    // Extract title
    let title = '';
    if (htmlContent) {
      const titleMatch = htmlContent.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      if (titleMatch) {
        title = titleMatch[1].trim().replace(/\s+/g, ' ');
      }
      if (!title) {
        const h1Match = htmlContent.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
        if (h1Match) {
          title = h1Match[1].replace(/<[^>]+>/g, '').trim().replace(/\s+/g, ' ');
        }
      }
    }
    if (!title) {
      title = filename.replace(/\.(html\.zip|zip|mhtml|mht|html|htm)$/i, '');
    }

    // Clean title
    title = title.replace(/^learning\s*activity\s*/i, '').trim();
    title = title.replace(/^(\d+\.\d+)[:\s_-]+/, '$1 ');

    return { unitNumber, lessonNumber, activityCode, isAssignment, title };
  }

  /**
   * Helper to decode quoted-printable text into a proper UTF-8 string
   */
  static decodeQuotedPrintable(str: string): string {
    const clean = str.replace(/=\r?\n/g, '');
    const bytes: number[] = [];
    for (let i = 0; i < clean.length; i++) {
      if (
        clean[i] === '=' &&
        i + 2 < clean.length &&
        /^[0-9A-Fa-f]{2}$/.test(clean.slice(i + 1, i + 3))
      ) {
        bytes.push(parseInt(clean.slice(i + 1, i + 3), 16));
        i += 2;
      } else {
        bytes.push(clean.charCodeAt(i));
      }
    }
    return Buffer.from(bytes).toString('utf8');
  }
}
