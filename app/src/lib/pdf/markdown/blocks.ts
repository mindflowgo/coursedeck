import { Marked, type Token, type Tokens } from 'marked';
import type { Content } from 'pdfmake/build/pdfmake';
import { COLORS, CONTENT_WIDTH, CALLOUTS, POSTIT } from '../theme';
import { box, dataTableLayout, dividerLine } from '../box';
import type { CompileContext } from '../types';
import { inlineTokensToSpans } from './inline';
import { normalizeMarkdown, BOX_MARKER, type ExtractedBox } from './preprocess';
import { htmlBlockToContent, calloutBox } from './htmlBlocks';
import { parseImageSpec, isIconImage } from './imageSpec';

const parser = new Marked({ gfm: true, breaks: true });

/**
 * Compiles a markdown document (raw lesson/summary/notes source, or the
 * body of a callout/post-it/details block) into pdfmake content blocks.
 * Pure string-in/content-out — no DOM access, so it runs in any JS runtime.
 */
export function compileMarkdownContent(markdown: string, ctx: CompileContext): Content[] {
  if (!markdown.trim()) return [];
  const { markdown: normalized, boxes } = normalizeMarkdown(markdown, ctx.courseId);
  const tokens = parser.lexer(normalized) as Token[];
  return walkTokens(tokens, ctx, boxes);
}

function walkTokens(tokens: Token[], ctx: CompileContext, boxes: ExtractedBox[]): Content[] {
  const out: Content[] = [];

  for (const token of tokens) {
    switch (token.type) {
      case 'space':
      case 'def':
        break;

      case 'heading': {
        const heading = token as Tokens.Heading;
        out.push({
          text: inlineTokensToSpans(heading.tokens, ctx),
          style: `h${Math.min(heading.depth, 4)}`
        } as Content);
        break;
      }

      case 'paragraph': {
        const para = token as Tokens.Paragraph;
        const resolved = tryResolveMarker(para.text, boxes, ctx);
        if (resolved) {
          out.push(...resolved);
          break;
        }
        // Standalone figure: paragraph containing exactly one block image
        const inlineTokens = para.tokens ?? [];
        if (inlineTokens.length === 1 && inlineTokens[0].type === 'image') {
          out.push(...figureContent(inlineTokens[0] as Tokens.Image, ctx));
          break;
        }
        out.push({ text: inlineTokensToSpans(inlineTokens, ctx), style: 'body' } as Content);
        break;
      }

      case 'text': {
        const textToken = token as Tokens.Text;
        const resolved = tryResolveMarker(textToken.text, boxes, ctx);
        if (resolved) {
          out.push(...resolved);
          break;
        }
        if (textToken.tokens && textToken.tokens.length > 0) {
          out.push({ text: inlineTokensToSpans(textToken.tokens, ctx), style: 'body' } as Content);
        } else if (textToken.text.trim()) {
          out.push({ text: inlineTokensToSpans([textToken], ctx), style: 'body' } as Content);
        }
        break;
      }

      case 'list': {
        out.push(listToContent(token as Tokens.List, ctx));
        break;
      }

      case 'table': {
        out.push(tableToContent(token as Tokens.Table, ctx));
        break;
      }

      case 'code': {
        const code = token as Tokens.Code;
        out.push(
          box(
            [
              code.lang
                ? { text: code.lang.toUpperCase(), fontSize: 7, color: COLORS.faint, margin: [0, 0, 0, 3] }
                : null,
              { text: code.text, style: 'codeBlock' }
            ].filter(Boolean) as Content[],
            { fill: COLORS.softFill, borderColor: COLORS.border, padding: [8, 8, 8, 10] }
          )
        );
        break;
      }

      case 'blockquote': {
        const quote = token as Tokens.Blockquote;
        out.push(box(walkTokens(quote.tokens ?? [], ctx, boxes), { fill: COLORS.softFill, borderColor: COLORS.borderDark }));
        break;
      }

      case 'hr': {
        out.push(dividerLine(CONTENT_WIDTH));
        break;
      }

      case 'html': {
        out.push(...htmlBlockToContent((token as Tokens.HTML).text, ctx));
        break;
      }

      default: {
        const fallback = (token as { text?: string }).text;
        if (fallback && fallback.trim()) {
          out.push({ text: inlineTokensToSpans(undefined, ctx).concat([fallback]), style: 'body' } as Content);
        }
        break;
      }
    }
  }

  return out;
}

function tryResolveMarker(
  text: string | undefined,
  boxes: ExtractedBox[],
  ctx: CompileContext
): Content[] | null {
  if (!text) return null;
  const m = text.match(new RegExp(`^\\s*${BOX_MARKER.source}\\s*$`));
  if (!m) return null;
  const boxDef = boxes[Number(m[1])];
  if (!boxDef) return null;

  if (boxDef.kind === 'callout') {
    const meta = CALLOUTS[boxDef.type] ?? CALLOUTS.note;
    return [calloutBox(meta.label, meta, boxDef.bodyMarkdown, ctx)];
  }

  // AI post-it note
  const header: Content[] = [
    {
      text: [
        { text: '💡 AI Note', bold: true, fontSize: 9.5, color: POSTIT.title },
        ...(boxDef.query ? [{ text: `  —  ${boxDef.query}`, fontSize: 9.5, color: POSTIT.accent }] : [])
      ],
      margin: [0, 0, 0, 4]
    } as Content
  ];
  if (boxDef.targetText) {
    header.push({
      text: `Referencing: "${boxDef.targetText}"`,
      italics: true,
      fontSize: 8,
      color: POSTIT.accent,
      margin: [0, 0, 0, 5]
    } as Content);
  }
  return [
    box([...header, ...compileMarkdownContent(boxDef.bodyMarkdown, ctx)], {
      fill: POSTIT.fill,
      borderColor: POSTIT.border
    })
  ];
}

/** Inline tokens of a tight list-item text token (tokens may be absent). */
function itemTextSpans(piece: Tokens.Text, ctx: CompileContext, prefix: unknown[] = []): unknown[] {
  const inline = piece.tokens && piece.tokens.length > 0 ? piece.tokens : [piece as unknown as Token];
  return [...prefix, ...inlineTokensToSpans(inline, ctx)];
}

function listToContent(token: Tokens.List, ctx: CompileContext): Content {
  const manualStart = token.ordered && typeof token.start === 'number' && token.start > 1;
  let counter = typeof token.start === 'number' ? token.start : 1;

  const items = token.items.map((item) => {
    const taskPrefix = item.task
      ? [
          {
            text: item.checked ? '✓ ' : '☐ ',
            color: item.checked ? COLORS.answerGreen : COLORS.faint,
            bold: item.checked
          }
        ]
      : [];
    const labelPrefix = manualStart ? [{ text: `${counter++}. `, color: COLORS.muted }] : [];

    const pieces = (item.tokens ?? []).filter((t) => t.type !== 'space');
    const hasBlockChildren = pieces.some((t) => t.type !== 'text');

    if (!hasBlockChildren) {
      const spans: unknown[] = [...labelPrefix, ...taskPrefix];
      for (const piece of pieces) {
        spans.push(...itemTextSpans(piece as Tokens.Text, ctx));
      }
      if (spans.length === 1 && typeof spans[0] === 'string') return spans[0];
      return { text: spans };
    }

    const stack: Content[] = [];
    let firstText = true;
    for (const piece of pieces) {
      if (piece.type === 'list') {
        stack.push(listToContent(piece as Tokens.List, ctx));
      } else if (piece.type === 'text') {
        const spans = itemTextSpans(
          piece as Tokens.Text,
          ctx,
          firstText ? [...labelPrefix, ...taskPrefix] : []
        );
        stack.push({ text: spans, style: 'body' } as Content);
      } else {
        stack.push(...walkTokens([piece], ctx, []));
      }
      firstText = false;
    }
    return { stack, style: 'listItem' };
  });

  if (manualStart) {
    return { ul: items, margin: [0, 0, 0, 8] } as unknown as Content;
  }

  return {
    [token.ordered ? 'ol' : 'ul']: items,
    margin: [0, 0, 0, 8]
  } as unknown as Content;
}

function mapAlign(align: string | null | undefined): string | undefined {
  if (align === 'center') return 'center';
  if (align === 'right') return 'right';
  return undefined;
}

function tableToContent(token: Tokens.Table, ctx: CompileContext): Content {
  const widths: string[] = token.header.map(() => '*');

  const headerRow = token.header.map((cell, i) => ({
    text: inlineTokensToSpans(cell.tokens, ctx),
    bold: true,
    fillColor: COLORS.headerFill,
    alignment: mapAlign(token.align[i])
  }));

  const bodyRows = token.rows.map((row) =>
    row.map((cell, i) => ({
      text: inlineTokensToSpans(cell.tokens, ctx),
      alignment: mapAlign(token.align[i])
    }))
  );

  return {
    table: {
      headerRows: 1,
      widths,
      body: [headerRow, ...bodyRows]
    },
    layout: dataTableLayout(),
    margin: [0, 2, 0, 12]
  } as Content;
}

function figureContent(imageToken: Tokens.Image, ctx: CompileContext): Content[] {
  const spec = parseImageSpec(imageToken.text || '');
  const node = ctx.embedImage(imageToken.href, spec, 'block') as Record<string, unknown>;
  node.alignment = 'center';
  node.margin = [0, 4, 0, 2];
  const out: Content[] = [node as unknown as Content];

  const showCaption = spec.alt && !/\.(jpe?g|png|gif|webp|svg)$/i.test(spec.alt);
  if (showCaption) {
    out.push({ text: spec.alt, style: 'caption', alignment: 'center' } as Content);
  }
  return out;
}
