import { describe, expect, it, beforeEach, afterEach, spyOn } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { handleApiRequest } from './api';
import { CourseService } from './courses';
import { LLMService } from './llm';

describe('Course Builder Endpoints', () => {
  const testCourseId = 'builder_test_101';
  const testCourseDir = path.join(CourseService.getCoursesDir(), testCourseId);

  beforeEach(() => {
    if (fs.existsSync(testCourseDir)) {
      fs.rmSync(testCourseDir, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(testCourseDir)) {
      fs.rmSync(testCourseDir, { recursive: true, force: true });
    }
  });

  describe('POST /api/courses', () => {
    it('creates a course with units and lessons', async () => {
      const payload = {
        id: testCourseId,
        title: 'Introduction to Computer Science',
        grade: '11',
        level: 'University',
        description: 'Foundations of programming and algorithms.',
        units: [
          {
            number: 1,
            title: 'Unit 1: Programming Basics',
            lessons: [
              {
                id: '01.01',
                title: 'Variables and Expressions',
                type: 'lesson',
                content: '# Variables and Expressions\n\nIntro to variables.'
              },
              {
                id: '01.02',
                title: 'Unit 1 Project',
                type: 'assignment',
                content: '# Unit 1 Project\n\nBuild a calculator.'
              }
            ]
          }
        ]
      };

      const req = new Request('http://127.0.0.1:3182/api/courses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const res = await handleApiRequest(req, new URL(req.url));
      expect(res.status).toBe(201);

      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.courseId).toBe(testCourseId);
      expect(data.course.title).toBe('Introduction to Computer Science');
      expect(data.course.units.length).toBe(1);
      expect(data.course.units[0].lessons.length).toBe(2);
      expect(data.course.units[0].lessons[0].id).toBe('01-01');
      expect(data.course.units[0].lessons[1].type).toBe('assignment');

      // Check files on disk
      expect(fs.existsSync(testCourseDir)).toBe(true);
      const meta = JSON.parse(fs.readFileSync(path.join(testCourseDir, '.manifest.json'), 'utf8'));
      expect(meta.title).toBe('Introduction to Computer Science');

      // Check lesson content was written
      const lessonPath = path.join(testCourseDir, '01-01.lesson.md');
      expect(fs.existsSync(lessonPath)).toBe(true);
      expect(fs.readFileSync(lessonPath, 'utf8')).toContain('Variables and Expressions');
    });

    it('creates a course with coursePDF and lesson pageRange metadata', async () => {
      const pdfTestCourseId = 'test_cs_pdf_builder';
      const pdfTestDir = path.join(CourseService.getCoursesDir(), pdfTestCourseId);
      if (fs.existsSync(pdfTestDir)) fs.rmSync(pdfTestDir, { recursive: true, force: true });

      const payload = {
        id: pdfTestCourseId,
        title: 'Computer Science with Textbook',
        coursePDF: true,
        units: [
          {
            number: 1,
            title: 'Unit 1: Programming Basics',
            lessons: [
              {
                id: '01.01',
                title: 'Introduction',
                pageRange: '14-28',
                readingDescription: 'Chapter 1: Foundations',
                content: '# Intro\nNotes.'
              }
            ]
          }
        ]
      };

      const req = new Request('http://127.0.0.1:3182/api/courses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const res = await handleApiRequest(req, new URL(req.url));
      expect(res.status).toBe(201);

      const data = await res.json();
      expect(data.course.coursePDF).toBe(true);
      expect(data.course.units[0].lessons[0].pageRange).toBe('14-28');
      expect(data.course.units[0].lessons[0].readingDescription).toBe('Chapter 1: Foundations');

      const meta = JSON.parse(fs.readFileSync(path.join(pdfTestDir, '.manifest.json'), 'utf8'));
      expect(meta.coursePDF).toBe(true);
      expect(meta.units[0].lessons[0].pageRange).toBe('14-28');

      // Test dynamically detecting coursePDF if locker_docs/course.pdf exists on disk
      delete meta.coursePDF;
      fs.writeFileSync(path.join(pdfTestDir, '.manifest.json'), JSON.stringify(meta), 'utf8');
      expect(CourseService.getCourse(pdfTestCourseId)?.coursePDF).toBeFalsy();

      // Create locker_docs/course.pdf
      const lockerDir = path.join(pdfTestDir, 'assets', 'locker_docs');
      fs.mkdirSync(lockerDir, { recursive: true });
      fs.writeFileSync(path.join(lockerDir, 'course.pdf'), 'dummy pdf content', 'utf8');

      // Now getCourse must detect coursePDF as true
      expect(CourseService.getCourse(pdfTestCourseId)?.coursePDF).toBe(true);

      fs.rmSync(pdfTestDir, { recursive: true, force: true });
    });

    it('returns 409 Conflict if course already exists', async () => {
      fs.mkdirSync(testCourseDir, { recursive: true });
      fs.writeFileSync(path.join(testCourseDir, '.manifest.json'), '{}', 'utf8');

      const req = new Request('http://127.0.0.1:3182/api/courses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: testCourseId,
          title: 'Duplicate Course'
        })
      });

      const res = await handleApiRequest(req, new URL(req.url));
      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.message).toContain('already exists');
    });

    it('returns 400 Bad Request on invalid course id or empty title', async () => {
      const invalidIdReq = new Request('http://127.0.0.1:3182/api/courses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'invalid/course/id',
          title: 'Test'
        })
      });
      const res1 = await handleApiRequest(invalidIdReq, new URL(invalidIdReq.url));
      expect(res1.status).toBe(400);

      const emptyTitleReq = new Request('http://127.0.0.1:3182/api/courses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'valid_id',
          title: '   '
        })
      });
      const res2 = await handleApiRequest(emptyTitleReq, new URL(emptyTitleReq.url));
      expect(res2.status).toBe(400);
    });
  });

  describe('POST /api/builder/propose', () => {
    it('returns 400 if no text content is provided', async () => {
      const req = new Request('http://127.0.0.1:3182/api/builder/propose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '' })
      });

      const res = await handleApiRequest(req, new URL(req.url));
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.message).toContain('No readable text');
    });

    it('extracts text from plain text input and parses JSON proposal', async () => {
      const mockResult = {
        title: 'Physics 12',
        suggestedId: 'sph4u',
        grade: '12',
        level: 'University',
        description: 'Physics grade 12 university preparation',
        units: [
          {
            number: 1,
            title: 'Unit 1: Kinematics',
            lessons: [
              {
                id: '01.01',
                title: 'Motion in One Dimension',
                type: 'lesson',
                content: '# Motion in One Dimension\n\nSpeed, velocity, acceleration.'
              }
            ]
          }
        ]
      };

      const configSpy = spyOn(LLMService, 'loadStoredConfig').mockReturnValue({
        baseUrl: 'http://mock-ai',
        model: 'test-model'
      } as any);

      const spy = spyOn(LLMService, 'generateResult').mockResolvedValueOnce({
        completion: '```json\n' + JSON.stringify(mockResult) + '\n```',
        usage: { promptTokens: 10, completionTokens: 50, totalTokens: 60 }
      } as any);

      const req = new Request('http://127.0.0.1:3182/api/builder/propose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: '# Physics 12 Syllabus\nUnit 1: Kinematics\nUnit 2: Dynamics\nUnit 3: Energy',
          instructions: 'Keep it to 3 units'
        })
      });

      const res = await handleApiRequest(req, new URL(req.url));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.proposal.title).toBe('Physics 12');
      expect(data.proposal.suggestedId).toBe('sph4u');
      expect(data.proposal.units.length).toBe(1);
      expect(data.proposal.units[0].lessons[0].id).toBe('01-01');

      spy.mockRestore();
      configSpy.mockRestore();
    });

    it('extracts text from an uploaded PDF file and parses JSON proposal', async () => {
      const samplePdfPath = path.resolve('data.old/courses/clu3m/assets/locker_docs/clu3m_01_glossary.pdf');
      if (!fs.existsSync(samplePdfPath)) return;

      const mockResult = {
        title: 'Canadian Law',
        suggestedId: 'clu3m',
        grade: '11',
        level: 'University/College',
        description: 'Canadian law course',
        units: [
          {
            number: 1,
            title: 'Unit 1: Heritage',
            lessons: [
              {
                id: '01.01',
                title: 'Legal Foundations',
                type: 'lesson',
                content: '# Legal Foundations\n\nIntroduction to law.'
              }
            ]
          }
        ]
      };

      const configSpy = spyOn(LLMService, 'loadStoredConfig').mockReturnValue({
        baseUrl: 'http://mock-ai',
        model: 'test-model'
      } as any);

      let capturedPrompt = '';
      const spy = spyOn(LLMService, 'generateResult').mockImplementation(async (_cfg, _sys, userPrompt) => {
        capturedPrompt = userPrompt;
        return {
          completion: '```json\n' + JSON.stringify(mockResult) + '\n```',
          usage: { promptTokens: 10, completionTokens: 50, totalTokens: 60 }
        } as any;
      });

      const pdfBytes = fs.readFileSync(samplePdfPath);
      const formData = new FormData();
      formData.append('file', new File([pdfBytes], 'syllabus.pdf', { type: 'application/pdf' }));
      formData.append('instructions', 'Generate a structured curriculum');

      const req = new Request('http://127.0.0.1:3182/api/builder/propose', {
        method: 'POST',
        body: formData
      });

      const res = await handleApiRequest(req, new URL(req.url));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.proposal.title).toBe('Canadian Law');
      expect(capturedPrompt).toContain('Document: syllabus.pdf');
      expect(capturedPrompt.toLowerCase()).toContain('law');

      spy.mockRestore();
      configSpy.mockRestore();
    });

    it('uses companionMarkdown directly when provided in FormData', async () => {
      const mockResult = {
        title: 'Companion Test Course',
        suggestedId: 'comp101',
        grade: '11',
        level: 'University',
        description: 'Test course with companion markdown',
        units: [
          {
            number: 1,
            title: 'Unit 1: Foundations',
            lessons: [
              {
                id: '01.01',
                title: 'Lesson 1',
                type: 'lesson',
                pageRange: '10-25',
                readingDescription: 'Chapter 1: Read sections 1.1-1.4',
                externalRefs: ['https://example.com/video1'],
                content: '# Lesson 1\nContent.'
              }
            ]
          }
        ]
      };

      const configSpy = spyOn(LLMService, 'loadStoredConfig').mockReturnValue({
        baseUrl: 'http://mock-ai',
        model: 'test-model'
      } as any);

      let capturedPrompt = '';
      const spy = spyOn(LLMService, 'generateResult').mockImplementation(async (_cfg, _sys, userPrompt) => {
        capturedPrompt = userPrompt;
        return {
          completion: '```json\n' + JSON.stringify(mockResult) + '\n```',
          usage: { promptTokens: 10, completionTokens: 50, totalTokens: 60 }
        } as any;
      });

      const companionMd = '<!-- page: 1 -->\n\n# Chapter 1\nIntro text\n\n<!-- page: 2 -->\n\nMore details';
      const formData = new FormData();
      formData.append('file', new File([new Uint8Array([1, 2, 3])], 'book.pdf', { type: 'application/pdf' }));
      formData.append('companionMarkdown', companionMd);
      formData.append('instructions', 'Build lessons');

      const req = new Request('http://127.0.0.1:3182/api/builder/propose', {
        method: 'POST',
        body: formData
      });

      const res = await handleApiRequest(req, new URL(req.url));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.proposal.units[0].lessons[0].pageRange).toBe('10-25');
      expect(data.proposal.units[0].lessons[0].externalRefs[0].url).toBe('https://example.com/video1');
      expect(capturedPrompt).toContain('<!-- page: 1 -->');
      expect(capturedPrompt).toContain('Chapter 1');

      spy.mockRestore();
      configSpy.mockRestore();
    });

    it('extracts chapter text with page annotations from an EPUB file', async () => {
      const { zipSync, strToU8 } = await import('fflate');

      // Build a minimal valid EPUB zip
      const epubZip = zipSync({
        'mimetype': strToU8('application/epub+zip'),
        'META-INF/container.xml': strToU8(
          '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'
        ),
        'content.opf': strToU8(
          '<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata></metadata><manifest><item id="c1" href="chap1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>'
        ),
        'chap1.xhtml': strToU8(
          '<?xml version="1.0" encoding="utf-8"?><html><body><h1>Chapter 1: Kinematics</h1><p>Motion in one dimension is described using vectors, velocity, acceleration, and position coordinates over time.</p></body></html>'
        )
      });

      const mockResult = {
        title: 'EPUB Physics',
        units: [
          {
            number: 1,
            title: 'Unit 1: Kinematics',
            lessons: [{ id: '01.01', title: 'Motion', type: 'lesson', pageRange: '1', content: '# Motion' }]
          }
        ]
      };

      const configSpy = spyOn(LLMService, 'loadStoredConfig').mockReturnValue({
        baseUrl: 'http://mock-ai',
        model: 'test-model'
      } as any);

      let capturedPrompt = '';
      const spy = spyOn(LLMService, 'generateResult').mockImplementation(async (_cfg, _sys, userPrompt) => {
        capturedPrompt = userPrompt;
        return {
          completion: '```json\n' + JSON.stringify(mockResult) + '\n```',
          usage: { promptTokens: 10, completionTokens: 50, totalTokens: 60 }
        } as any;
      });

      const formData = new FormData();
      formData.append('file', new File([epubZip], 'physics.epub', { type: 'application/epub+zip' }));

      const req = new Request('http://127.0.0.1:3182/api/builder/propose', {
        method: 'POST',
        body: formData
      });

      const res = await handleApiRequest(req, new URL(req.url));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(capturedPrompt).toContain('<!-- page: 1 -->');
      expect(capturedPrompt).toContain('Chapter 1: Kinematics');

      spy.mockRestore();
      configSpy.mockRestore();
    });
  });

  describe('POST /api/builder/generate-lesson', () => {
    it('returns 400 if lesson title is missing', async () => {
      const req = new Request('http://127.0.0.1:3182/api/builder/generate-lesson', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lessonTitle: '' })
      });

      const res = await handleApiRequest(req, new URL(req.url));
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.message).toContain('Lesson title is required');
    });

    it('generates starter markdown for a lesson', async () => {
      const mockMarkdown = '# Friction and Normal Forces\n\n### Learning Goals\n- Understand normal forces';
      const configSpy = spyOn(LLMService, 'loadStoredConfig').mockReturnValue({
        baseUrl: 'http://mock-ai',
        model: 'test-model'
      } as any);

      const spy = spyOn(LLMService, 'generateResult').mockResolvedValueOnce({
        completion: mockMarkdown,
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 }
      } as any);

      const req = new Request('http://127.0.0.1:3182/api/builder/generate-lesson', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          courseTitle: 'Physics 12',
          unitTitle: 'Unit 2: Dynamics',
          lessonTitle: 'Friction and Normal Forces',
          grade: '12'
        })
      });

      const res = await handleApiRequest(req, new URL(req.url));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.content).toBe(mockMarkdown);

      spy.mockRestore();
      configSpy.mockRestore();
    });
  });

  describe('Companion Markdown Endpoints', () => {
    it('retrieves companion markdown for a course locker document', async () => {
      const courseId = 'locker_companion_test';
      const courseDir = path.join(CourseService.getCoursesDir(), courseId);
      const lockerDir = path.join(courseDir, 'assets', 'locker_docs');
      fs.mkdirSync(lockerDir, { recursive: true });
      fs.writeFileSync(path.join(lockerDir, 'test.pdf'), 'fake pdf');
      fs.writeFileSync(path.join(lockerDir, 'test.pdf.companion.md'), '<!-- page: 1 -->\n\n# Test Book');

      // Create dummy manifest so CourseService recognizes the course
      fs.writeFileSync(path.join(courseDir, '.manifest.json'), JSON.stringify({ id: courseId, title: 'Test' }));

      const req = new Request(`http://127.0.0.1:3182/api/courses/${courseId}/locker-docs?companion=true&file=test.pdf`);
      const res = await handleApiRequest(req, new URL(req.url));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.companion).toContain('<!-- page: 1 -->');
      expect(data.companion).toContain('Test Book');

      fs.rmSync(courseDir, { recursive: true, force: true });
    });

    it('retrieves companion markdown for a library document', async () => {
      const { LibraryService } = await import('./library');
      const libDir = LibraryService.getDir();
      if (!fs.existsSync(libDir)) fs.mkdirSync(libDir, { recursive: true });

      const testPdf = path.join(libDir, 'test_lib.pdf');
      const testComp = path.join(libDir, 'test_lib.pdf.companion.md');
      fs.writeFileSync(testPdf, 'fake pdf bytes');
      fs.writeFileSync(testComp, '<!-- page: 1 -->\n\n# Library Companion');

      const req = new Request('http://127.0.0.1:3182/api/library/companion/test_lib.pdf');
      const res = await handleApiRequest(req, new URL(req.url));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.companion).toContain('Library Companion');

      if (fs.existsSync(testPdf)) fs.unlinkSync(testPdf);
      if (fs.existsSync(testComp)) fs.unlinkSync(testComp);
    });

    it('serves HTML lesson content with base href, discovered stylesheets, and bridge script', async () => {
      const courseId = 'content_test_course';
      const courseDir = path.join(CourseService.getCoursesDir(), courseId);
      const cssDir = path.join(courseDir, 'assets', 'css');
      fs.mkdirSync(cssDir, { recursive: true });
      fs.writeFileSync(path.join(cssDir, 'ilc_core.css'), 'body { background: #fff; }');
      fs.writeFileSync(path.join(courseDir, '.manifest.json'), JSON.stringify({ id: courseId, title: 'Content Test' }));
      fs.writeFileSync(path.join(courseDir, '01-01.lesson.html'), '<html><head><title>Lesson 1</title></head><body><h1>Hello</h1></body></html>');

      const req = new Request(`http://127.0.0.1:3182/api/courses/${courseId}/01-01/content`);
      const res = await handleApiRequest(req, new URL(req.url));
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toContain('text/html');
      const body = await res.text();
      expect(body).toContain(`<base href="/api/courses/${courseId}/">`);
      expect(body).toContain('<link rel="stylesheet" href="./assets/css/ilc_core.css">');
      expect(body).toContain('courseDeck:lessonHeight');
      expect(body).toContain('courseDeck:openDocument');
      expect(body).toContain('courseDeck:navigateLesson');
      expect(body).toContain('data-toggle');

      fs.rmSync(courseDir, { recursive: true, force: true });
    });

    it('serves PDF lesson content as application/pdf binary', async () => {
      const courseId = 'pdf_content_test_course';
      const courseDir = path.join(CourseService.getCoursesDir(), courseId);
      fs.mkdirSync(courseDir, { recursive: true });
      fs.writeFileSync(path.join(courseDir, '.manifest.json'), JSON.stringify({ id: courseId, title: 'PDF Test' }));
      fs.writeFileSync(path.join(courseDir, '01-02.lesson.pdf'), 'fake pdf data buffer');

      const req = new Request(`http://127.0.0.1:3182/api/courses/${courseId}/01-02/content`);
      const res = await handleApiRequest(req, new URL(req.url));
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('application/pdf');

      fs.rmSync(courseDir, { recursive: true, force: true });
    });

    it('resolves image assets with fuzzy extensions and transparent 1x1 fallback', async () => {
      const courseId = 'asset_fallback_test_course';
      const courseDir = path.join(CourseService.getCoursesDir(), courseId);
      const imgDir = path.join(courseDir, 'assets', 'img');
      fs.mkdirSync(imgDir, { recursive: true });
      fs.writeFileSync(path.join(courseDir, '.manifest.json'), JSON.stringify({ id: courseId, title: 'Asset Test' }));
      fs.writeFileSync(path.join(imgDir, 'sample_header.jpg'), 'fake-jpeg-data');

      // 1. Fuzzy extension match: request .png, resolves to .jpg
      const fuzzyReq = new Request(`http://127.0.0.1:3182/api/courses/${courseId}/assets/img/sample_header.png`);
      const fuzzyRes = await handleApiRequest(fuzzyReq, new URL(fuzzyReq.url));
      expect(fuzzyRes.status).toBe(200);
      expect(fuzzyRes.headers.get('Content-Type')).toBe('image/jpeg');
      const fuzzyText = await fuzzyRes.text();
      expect(fuzzyText).toBe('fake-jpeg-data');

      // 2. Completely missing image: returns 1x1 transparent PNG fallback
      const missingReq = new Request(`http://127.0.0.1:3182/api/courses/${courseId}/assets/img/non_existent.png`);
      const missingRes = await handleApiRequest(missingReq, new URL(missingReq.url));
      expect(missingRes.status).toBe(200);
      expect(missingRes.headers.get('Content-Type')).toBe('image/png');
      expect(missingRes.headers.get('X-Asset-Fallback')).toBe('transparent-pixel');

      fs.rmSync(courseDir, { recursive: true, force: true });
    });
  });
});
