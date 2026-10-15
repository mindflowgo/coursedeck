import type { Content } from 'pdfmake/build/pdfmake';
import type { TDocumentDefinitions } from 'pdfmake/interfaces';
import { COLORS, CONTENT_WIDTH, PAGE, STYLES } from './theme';
import { tabBadgeLabel, type PdfExportOptions } from './types';

/**
 * Assembles the complete pdfmake document: curriculum header on page 1,
 * running header + "Page X of Y" footer, and the compiled body content.
 */
export function buildDocDefinition(options: PdfExportOptions, body: Content[]): TDocumentDefinitions {
  const dateStr = new Date().toLocaleDateString('en-CA', {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });

  const badge = tabBadgeLabel(options.tab);

  const doc: TDocumentDefinitions = {
    pageSize: 'A4',
    pageMargins: PAGE.margins,
    background: () => ({
      canvas: [
        {
          type: 'rect',
          x: 0,
          y: 0,
          w: PAGE.width,
          h: PAGE.height,
          color: COLORS.white
        }
      ]
    }),
    info: {
      title: `${options.courseCode.toUpperCase()} ${options.lessonId} — ${options.lessonTitle}`,
      subject: `${badge} — Independent Learning Centre (Ontario Secondary Curriculum)`,
      author: 'ILC Study Tool',
      creator: 'ILC Study Tool',
      keywords: [options.courseCode, options.lessonId, options.tab, 'ILC', 'study guide'].join(', ')
    },
    defaultStyle: {
      font: 'DejaVu',
      fontSize: 10.5,
      lineHeight: 1.4,
      color: COLORS.ink
    },
    styles: STYLES,

    // Running header from page 2 onward (page 1 carries the full curriculum header)
    header: (currentPage: number) => {
      if (currentPage === 1) return null;
      return {
        columns: [
          {
            text: `${options.courseCode.toUpperCase()}  •  Lesson ${options.lessonId}`,
            fontSize: 7.5,
            color: COLORS.faint
          },
          {
            text: options.tabDisplayName,
            fontSize: 7.5,
            color: COLORS.faint,
            alignment: 'right'
          }
        ],
        margin: [PAGE.margins[0], 18, PAGE.margins[2], 0]
      };
    },

    footer: (currentPage: number, pageCount: number) => ({
      text: `Page ${currentPage} of ${pageCount}`,
      fontSize: 7.5,
      color: COLORS.faint,
      alignment: 'right',
      margin: [PAGE.margins[0], 0, PAGE.margins[2], 20]
    }),

    content: [
      // ---- Curriculum header (page 1 only) ----
      {
        columns: [
          {
            // Lesson code badge: dark chip with white text (e.g. 01.01)
            table: {
              widths: ['auto'],
              body: [
                [
                  {
                    text: options.lessonId,
                    color: COLORS.white,
                    bold: true,
                    fontSize: 10,
                    characterSpacing: 1,
                    fillColor: COLORS.ink
                  }
                ]
              ]
            },
            layout: {
              hLineColor: () => COLORS.ink,
              vLineColor: () => COLORS.ink,
              hLineWidth: () => 0.75,
              vLineWidth: () => 0.75,
              paddingLeft: () => 7,
              paddingRight: () => 7,
              paddingTop: () => 3,
              paddingBottom: () => 3.5
            }
          },
          {
            stack: [
              { text: options.courseTitle, bold: true, fontSize: 10, color: COLORS.muted },
              {
                text: `${options.tabDisplayName} • ${dateStr}`,
                fontSize: 8,
                color: COLORS.faint,
                margin: [0, 2, 0, 0]
              }
            ],
            alignment: 'right'
          }
        ],
        columnGap: 12,
        margin: [0, 0, 0, 6]
      },
      {
        canvas: [
          {
            type: 'line',
            x1: 0,
            y1: 0,
            x2: CONTENT_WIDTH,
            y2: 0,
            lineWidth: 1.5,
            lineColor: COLORS.borderDark
          }
        ],
        margin: [0, 2, 0, 18]
      },

      // ---- Document body (opens with the lesson title heading) ----
      ...body
    ]
  };

  return doc;
}

/** Same filename convention as the previous export engine. */
export function buildFilename(options: PdfExportOptions): string {
  const cleanCourse = options.courseCode.replace(/[^a-zA-Z0-9_-]/g, '_').toUpperCase();
  const cleanLesson = options.lessonId.replace(/[^a-zA-Z0-9_.-]/g, '_');
  const cleanTab = options.tabDisplayName.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${cleanCourse}_${cleanLesson}_${cleanTab}.pdf`;
}
