import fs from 'node:fs';
import path from 'node:path';
import { CourseService } from './course.service';
import { getCoursesDir, safeJoin } from '../paths';
import { parseDocFileName } from '../../tabs';

export interface SearchMatch {
  courseId: string;
  courseTitle: string;
  lessonId?: string;
  lessonTitle?: string;
  tab: string;
  score: number;
  snippet: string;
}

export interface SearchResult {
  query: string;
  totalMatches: number;
  results: SearchMatch[];
}

export class SearchService {
  /**
   * Scored full-text search across course curriculum and notes.
   */
  static searchCourses(
    query: string,
    courseId?: string,
    limit: number = 20
  ): SearchResult {
    const rawTerms = query
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 0);

    if (rawTerms.length === 0) {
      return { query, totalMatches: 0, results: [] };
    }

    const courses = courseId
      ? [CourseService.getCourse(courseId)]
      : CourseService.listCourses({ includeArchived: false });

    const matches: SearchMatch[] = [];

    for (const course of courses) {
      const courseDir = safeJoin(getCoursesDir(), course.id);
      if (!fs.existsSync(courseDir)) continue;

      const entries = fs.readdirSync(courseDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue;

        // Skip internal/scratch files
        if (entry.name.startsWith('.') || entry.name.includes('.tmp.')) continue;

        const filePath = path.join(courseDir, entry.name);
        let content: string;
        try {
          content = fs.readFileSync(filePath, 'utf8');
        } catch {
          continue;
        }

        // Determine if it's a course doc or lesson file
        const parsed = parseDocFileName(entry.name);
        if (!parsed) continue;

        let lessonId: string | undefined;
        let lessonTitle: string | undefined;
        const tab = parsed.tab;

        if (!parsed.isCourseScope) {
          lessonId = parsed.lessonId;
          for (const unit of course.units) {
            const found = unit.lessons.find((l) => l.id === lessonId);
            if (found) {
              lessonTitle = found.title;
              break;
            }
          }
        }

        const score = this.computeScore(rawTerms, content, lessonTitle || course.title);
        if (score > 0) {
          const snippet = this.extractSnippet(rawTerms, content);
          matches.push({
            courseId: course.id,
            courseTitle: course.title,
            lessonId,
            lessonTitle,
            tab,
            score,
            snippet
          });
        }
      }
    }

    // Sort by score descending
    matches.sort((a, b) => b.score - a.score);
    const paginated = matches.slice(0, Math.max(1, limit));

    return {
      query,
      totalMatches: matches.length,
      results: paginated
    };
  }

  private static computeScore(terms: string[], content: string, title?: string): number {
    let score = 0;
    const lowerContent = content.toLowerCase();
    const lowerTitle = title ? title.toLowerCase() : '';

    // Check title match
    for (const term of terms) {
      if (lowerTitle.includes(term)) {
        score += 10;
      }
    }

    // Scan lines for header matches vs body matches
    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      const isHeader = trimmed.startsWith('#');
      const lowerLine = trimmed.toLowerCase();

      for (const term of terms) {
        if (lowerLine.includes(term)) {
          if (isHeader) {
            score += 5;
          } else {
            score += 1;
          }
        }
      }
    }

    return score;
  }

  private static extractSnippet(terms: string[], content: string): string {
    const lowerContent = content.toLowerCase();
    let earliestPos = -1;

    for (const term of terms) {
      const pos = lowerContent.indexOf(term);
      if (pos !== -1) {
        if (earliestPos === -1 || pos < earliestPos) {
          earliestPos = pos;
        }
      }
    }

    if (earliestPos === -1) {
      earliestPos = 0;
    }

    const start = Math.max(0, earliestPos - 75);
    const end = Math.min(content.length, earliestPos + 105);

    let snippet = content.slice(start, end).replace(/\r?\n/g, ' ');

    // Clean up excessive markdown symbols
    snippet = snippet
      .replace(/#+/g, '')
      .replace(/[*_~`]/g, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .trim();

    return (start > 0 ? '...' : '') + snippet + (end < content.length ? '...' : '');
  }
}
