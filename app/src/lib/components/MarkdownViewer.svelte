<script lang="ts">
  import { Marked } from 'marked';
  import MarkupLayer from './MarkupLayer.svelte';
  import { extractMathFromMarkdown, restoreMathTokens } from '$lib/markdown/mathRenderer';
  import { repairMarkdownTables } from '$lib/markdown/tableRepair';
  import DOMPurify from 'dompurify';
  import { getApiBaseUrl } from '$lib/api';
  import { parseCssImageSpec, isIconImage } from '$lib/markdown/imageSpec';
  import { confirmDialog } from '$lib/dialog';
  import { onMount } from 'svelte';
  import {
    afterPaint,
    assetReport,
    contentSignature,
    perf,
    stagesSummary,
    stagesTotal,
    timeStage,
    type PerfStage
  } from '$lib/perf';

  /** Last markdown fed to the pipeline, kept for the `__ilcMarkedProbe` diagnostic. */
  let lastMarkdownForProbe = '';

  /**
   * Bisects marked's own cost in whatever runtime this runs in. marked is pure
   * JS, so the same input costs the same everywhere unless something about the
   * runtime is off; comparing lexing against HTML generation, and real content
   * against synthetic content of the same size, says which.
   *
   * Run `__ilcMarkedProbe()` in the console of a slow environment, or
   * `__ilcMarkedProbe('some markdown')` to test specific content.
   */
  function installMarkedProbe(): void {
    if (typeof window === 'undefined') return;

    (window as unknown as Record<string, unknown>).__ilcMarkedProbe = (text?: string) => {
      const input = text ?? lastMarkdownForProbe;
      const results: Record<string, unknown> = { inputChars: input.length };
      const t = <T>(label: string, fn: () => T): T => {
        const t0 = performance.now();
        const out = fn();
        results[label] = +(performance.now() - t0).toFixed(1);
        return out;
      };

      const tokens = t('lexer', () => markedParser.lexer(input));
      t('parser', () => markedParser.parser(tokens));
      // A second pass distinguishes a one-off stall from a persistent cost.
      t('lexer_again', () => markedParser.lexer(input));

      const filler = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. ';
      const plain = filler.repeat(Math.ceil(input.length / filler.length)).slice(0, input.length);
      results.syntheticChars = plain.length;
      t('lexer_synthetic_plaintext', () => markedParser.lexer(plain));

      const tableUnit = '| a | b | c |\n| --- | --- | --- |\n';
      const table = tableUnit.repeat(Math.ceil(input.length / tableUnit.length)).slice(0, input.length);
      t('lexer_synthetic_tables', () => markedParser.lexer(table));

      results.userAgent = navigator.userAgent;
      results.cores = navigator.hardwareConcurrency;
      results.deviceMemory = (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? null;

      // DevTools-open probe: an inspected object triggers this getter.
      let devtoolsOpen = false;
      try {
        const el = new Image();
        Object.defineProperty(el, 'id', {
          get() {
            devtoolsOpen = true;
            return 'probe';
          }
        });
        console.log(el);
      } catch {}
      results.devtoolsOpen = devtoolsOpen;

      perf('marked-probe', results, '[PERF][marked-probe] see object for the breakdown');
      return results;
    };
  }

  interface Props {
    markdown: string;
    courseId: string;
    onDeleteNote?: (targetText: string, query: string) => void;
    onOpenDocument?: (url: string, title?: string) => void;
    /** Doc file key for free-hand markup annotations (omits the overlay). */
    markupFile?: string;
    /** Scroll container used for finger-pan while in markup mode. */
    markupScroller?: HTMLElement | null;
  }

  let { markdown, courseId, onDeleteNote, onOpenDocument, markupFile, markupScroller }: Props = $props();

  let containerEl: HTMLElement | null = $state(null);

  function escapeHtml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function renderCustomImage(href: string, text: string | null | undefined, title?: string | null): string {
    const rawText = text || '';
    const spec = parseCssImageSpec(rawText);
    const cleanAlt = spec.alt;

    const isIcon = isIconImage(href, cleanAlt, spec.isCustom);

    if (isIcon) {
      let iconStyle = '';
      if (spec.width) iconStyle += `width: ${spec.width}; `;
      if (spec.height) iconStyle += `height: ${spec.height}; `;
      return `<img src="${href}" alt="${escapeHtml(cleanAlt)}" class="inline-block align-middle my-0.5 border-0 rounded-none shadow-none max-h-8 w-auto max-w-full" style="${iconStyle.trim()}" loading="lazy" />`;
    }

    let styleParts: string[] = [];
    if (spec.width) styleParts.push(`width: ${spec.width};`);
    if (spec.height) styleParts.push(`height: ${spec.height};`);
    if (!spec.width && !spec.height) {
      styleParts.push('max-height: 480px; width: auto;');
    }
    const styleAttr = styleParts.join(' ');
    const showCaption = cleanAlt && !/\.(jpe?g|png|gif|webp|svg)$/i.test(cleanAlt);

    const rawHref = (href || '').trim();
    const isSafeHref = /^(?:(?:https?|file|asset|tauri):|\/|\.\/|\.\.\/|data:image\/|blob:)/i.test(rawHref);
    const safeHref = isSafeHref ? rawHref : '';

    return `<span class="image-container not-prose my-6 mx-auto block text-center group/img relative select-none">
  <span class="image-inner inline-block relative max-w-full">
    <img
      src="${escapeHtml(safeHref)}"
      alt="${escapeHtml(cleanAlt)}"
      class="image-resizable rounded-xl border border-stone-200/90 bg-stone-50 shadow-xs hover:shadow-md transition-all duration-200 mx-auto cursor-zoom-in block max-w-full"
      style="${styleAttr}"
      loading="lazy"
    />
    <span class="image-toolbar absolute top-2 right-2 opacity-0 group-hover/img:opacity-100 transition-opacity duration-150 bg-stone-900/90 backdrop-blur-md text-white rounded-lg shadow-md px-1.5 py-1 flex items-center gap-1 text-[11px] font-medium z-10 pointer-events-auto">
      <span class="text-[10px] text-stone-400 font-semibold px-1 select-none uppercase tracking-wider">Size</span>
      <button
        type="button"
        data-action="scale-img"
        data-scale="auto"
        title="Reset to default fit"
        class="scale-chip px-1.5 py-0.5 rounded ${!spec.width ? 'bg-amber-500 text-white font-semibold' : 'text-stone-300'} hover:text-white hover:bg-stone-800 transition active:scale-95 cursor-pointer"
      >Auto</button>
      <button
        type="button"
        data-action="scale-img"
        data-scale="25%"
        title="Scale to 25% (Markdown: ![alt|25%](...))"
        class="scale-chip px-1.5 py-0.5 rounded ${spec.width === '25%' ? 'bg-amber-500 text-white font-semibold' : 'text-stone-300'} hover:text-white hover:bg-stone-800 transition active:scale-95 cursor-pointer"
      >25%</button>
      <button
        type="button"
        data-action="scale-img"
        data-scale="50%"
        title="Scale to 50% (Markdown: ![alt|50%](...))"
        class="scale-chip px-1.5 py-0.5 rounded ${spec.width === '50%' ? 'bg-amber-500 text-white font-semibold' : 'text-stone-300'} hover:text-white hover:bg-stone-800 transition active:scale-95 cursor-pointer"
      >50%</button>
      <button
        type="button"
        data-action="scale-img"
        data-scale="75%"
        title="Scale to 75% (Markdown: ![alt|75%](...))"
        class="scale-chip px-1.5 py-0.5 rounded ${spec.width === '75%' ? 'bg-amber-500 text-white font-semibold' : 'text-stone-300'} hover:text-white hover:bg-stone-800 transition active:scale-95 cursor-pointer"
      >75%</button>
      <button
        type="button"
        data-action="scale-img"
        data-scale="100%"
        title="Scale to 100% (Markdown: ![alt|100%](...))"
        class="scale-chip px-1.5 py-0.5 rounded ${spec.width === '100%' ? 'bg-amber-500 text-white font-semibold' : 'text-stone-300'} hover:text-white hover:bg-stone-800 transition active:scale-95 cursor-pointer"
      >100%</button>
      <span class="w-px h-3.5 bg-stone-700 mx-0.5"></span>
      <button
        type="button"
        data-action="view-fullscreen"
        title="Open full size in document viewer"
        class="px-1.5 py-0.5 rounded text-stone-300 hover:text-white hover:bg-stone-800 transition active:scale-95 cursor-pointer flex items-center gap-1"
      >
        <span class="text-xs">⛶</span>
        <span>Full</span>
      </button>
    </span>
  </span>
  ${showCaption ? `<span class="block text-xs text-stone-500 mt-2 font-normal italic select-none">${escapeHtml(cleanAlt)}</span>` : ''}
</span>`;
  }

  const markedParser = new Marked({ gfm: true, breaks: true });
  markedParser.use({
    renderer: {
      image(token) {
        return renderCustomImage(token.href, token.text, token.title);
      }
    }
  });

  /**
   * Counter + signature of the last render. A single view showing several
   * runs for the same signature means the pipeline is being re-run on
   * unchanged input, which is invisible from the outside but multiplies the
   * per-render cost.
   */
  let renderCount = 0;
  let lastSignature = '';

  let renderedHtml = $derived.by(() => {
    if (!markdown) return '';

    const stages: PerfStage[] = [];
    const startedAt = performance.now();
    const signature = contentSignature(markdown);
    renderCount += 1;
    lastMarkdownForProbe = markdown;

    // 1. Strip YAML frontmatter
    let cleaned = timeStage(stages, 'frontmatter', () =>
      markdown.replace(/^---[\s\S]*?---\s*/, '')
    );

    // 2 + 3. Normalize Pandoc/Markdown-it attribute syntax and rewrite
    // asset paths to the API route.
    cleaned = timeStage(stages, 'asset-paths', () => {
      let out = cleaned.replace(
        /!\[(.*?)\]\((.*?)\)\{([^}]+)\}/g,
        (match, alt, url, attr) => `![${alt}|${attr.trim()}](${url})`
      );

      const apiBase = getApiBaseUrl();
      out = out.replace(
        /(?:src|href)=["'](?:\.\/)?assets\/(.*?)["']/gi,
        `src="${apiBase}/api/courses/${courseId}/assets/$1"`
      );
      out = out.replace(
        /!\[(.*?)\]\((?:\.\/)?assets\/(.*?)\)/gi,
        `![$1](${apiBase}/api/courses/${courseId}/assets/$2)`
      );
      out = out.replace(
        /\[(.*?)\]\((?:\.\/)?assets\/(.*?)\)/gi,
        `[$1](${apiBase}/api/courses/${courseId}/assets/$2)`
      );
      return out;
    });

    // 4. Process GFM Callouts: > [!NOTE], > [!TIP], > [!IMPORTANT], > [!WARNING], > [!CAUTION]
    cleaned = timeStage(stages, 'callouts', () =>
      cleaned.replace(
        /> \[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*\n((?:>.*(?:\n|$))*)/gi,
        (match, type, content) => {
          const cleanType = type.toLowerCase();
          const body = content.replace(/^>\s?/gm, '');
          return `<div class="callout callout-${cleanType}">\n\n${body}\n\n</div>\n\n`;
        }
      )
    );

    // 5. Process GFM AI Post-It Notes: > [!USERNOTE] <query>\n> <!-- target: "..." -->\n> body...
    const userNotes: string[] = [];
    cleaned = timeStage(stages, 'user-notes', () => cleaned.replace(
      />\s*\[!USERNOTE\]([^\n]*)\n((?:>.*(?:\n|$))*)/gi,
      (match, queryMatch, content) => {
        const noteId = `note-${userNotes.length}`;
        const cleanQuery = (queryMatch || '').trim();
        const cleanBlock = content.replace(/^>\s?/gm, '');

        let targetText = '';
        const targetMatch = cleanBlock.match(/<!--\s*target:\s*"([\s\S]*?)"\s*-->/i);
        if (targetMatch) {
          targetText = targetMatch[1].replace(/\\"/g, '"').trim();
        }

        const bodyMarkdown = cleanBlock.replace(/<!--\s*target:\s*[\s\S]*?-->/gi, '').trim();
        const repairedBody = repairMarkdownTables(bodyMarkdown);
        const { processedMarkdown: noteMd, mathTokens: noteTokens } = extractMathFromMarkdown(repairedBody);
        let bodyHtml = markedParser.parse(noteMd) as string;
        bodyHtml = restoreMathTokens(bodyHtml, noteTokens);

        const postItHtml = `
<div class="postit-container not-prose my-5" data-note-id="${noteId}" data-target="${escapeHtml(targetText)}">
  <details class="postit-card group rounded-2xl border border-amber-300/80 dark:border-amber-500/20 bg-gradient-to-br from-amber-50/95 via-amber-50/85 to-amber-100/50 dark:from-amber-950/20 dark:via-stone-900/50 dark:to-stone-900/80 p-4 shadow-2xs hover:shadow-xs transition duration-150">
    <summary class="postit-summary flex items-start justify-between cursor-pointer list-none select-none gap-3">
      <div class="flex items-start space-x-2.5 flex-1 min-w-0">
        <span class="inline-flex items-center space-x-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-amber-200/90 dark:bg-amber-950/60 text-amber-950 dark:text-amber-300 border border-amber-300/90 dark:border-amber-800/50 shadow-2xs shrink-0 mt-0.5">
          <span class="text-xs">💡</span>
          <span>AI Note</span>
        </span>
        <div class="flex-1 min-w-0">
          <div class="text-xs font-semibold text-amber-950 dark:text-amber-200 leading-snug">
            ${escapeHtml(cleanQuery || 'Study Note')}
          </div>
          ${targetText ? `<div class="text-[11px] text-amber-900/70 dark:text-amber-400/60 truncate mt-0.5 italic">"${escapeHtml(targetText)}"</div>` : ''}
        </div>
      </div>
      <div class="flex items-center space-x-1 shrink-0 pt-0.5">
        <button
          type="button"
          data-action="delete-note"
          data-query="${escapeHtml(cleanQuery)}"
          data-target="${escapeHtml(targetText)}"
          class="postit-delete-btn p-1 rounded-lg text-amber-800/60 dark:text-amber-400/60 hover:text-amber-950 dark:hover:text-amber-200 hover:bg-amber-200/70 dark:hover:bg-amber-900/40 transition cursor-pointer"
          title="Delete this AI note"
        >
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        </button>
        <span class="p-1 text-amber-800/70 dark:text-amber-400/70 group-open:rotate-180 transition-transform duration-200">
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
        </span>
      </div>
    </summary>
    <div class="postit-body mt-3 pt-3 border-t border-amber-200/70 dark:border-amber-900/40 text-xs text-stone-800 dark:text-stone-300 leading-relaxed space-y-2">
      ${bodyHtml}
      ${targetText ? `
        <div class="pt-2 mt-2 border-t border-amber-200/40 dark:border-amber-900/30 text-[11px] text-amber-900/60 dark:text-amber-400/60 flex items-center space-x-1">
          <span>Referencing:</span>
          <span class="italic font-medium truncate max-w-md">"${escapeHtml(targetText)}"</span>
        </div>
      ` : ''}
    </div>
  </details>
</div>`.trim();

        userNotes.push(postItHtml);
        return `\n\n%%%USERNOTE_${userNotes.length - 1}%%%\n\n`;
      }
    ));

    // 6. Repair multiline tables so they conform to GFM single-line table specifications
    cleaned = timeStage(stages, 'table-repair', () => repairMarkdownTables(cleaned));

    // 7. Pre-extract math formulas before markedParser so \(, \[, _, etc. are never mangled by CommonMark
    const { processedMarkdown: markdownWithoutMath, mathTokens } = timeStage(
      stages,
      'math-extract',
      () => extractMathFromMarkdown(cleaned)
    );

    // 8. Render Markdown via markedParser (chunked by section to eliminate WebKit O(N^2) lexer degradation)
    let html = timeStage(stages, 'marked', () => {
      const sectionDelimiter = /(?:\r?\n){2,}---(?:\r?\n){2,}/;
      let parts = markdownWithoutMath.split(sectionDelimiter);

      // If no '---' dividers exist but document is large (>50k chars), chunk on major headings
      if (parts.length <= 1 && markdownWithoutMath.length > 50000) {
        const headingParts = markdownWithoutMath.split(/(?=(?:\r?\n)+(?:#{1,2} ))/);
        if (headingParts.length > 1) {
          parts = headingParts;
        }
      }

      if (parts.length > 1) {
        const rendered = parts
          .map((part) => {
            const trimmed = part.trim();
            if (!trimmed) return '';
            const sectionHtml = markedParser.parse(trimmed) as string;
            return `<section class="markdown-section">\n${sectionHtml}\n</section>`;
          })
          .filter(Boolean);
        return rendered.join('\n<hr class="section-divider my-8 border-stone-200 dark:border-stone-800" />\n');
      }

      return markedParser.parse(markdownWithoutMath) as string;
    });

    // 9. Restore rendered KaTeX formulas
    html = timeStage(stages, 'katex', () => restoreMathTokens(html, mathTokens));

    // 10. Inject rendered Post-It Notes
    html = timeStage(stages, 'notes-inject', () => {
      let out = html.replace(/<p>\s*%%%USERNOTE_(\d+)%%%\s*<\/p>/g, (_, idx) => userNotes[Number(idx)] || '');
      out = out.replace(/%%%USERNOTE_(\d+)%%%/g, (_, idx) => userNotes[Number(idx)] || '');
      return out;
    });

    const sanitized = timeStage(stages, 'sanitize', () => sanitizeRenderedHtml(html));

    // One line per render. Repeated lines carrying the same signature mean the
    // pipeline is re-running on unchanged input, which multiplies its cost.
    const repeated = signature === lastSignature;
    lastSignature = signature;
    const imageCount = (sanitized.match(/<img/g) || []).length;
    perf(
      'markdown-render',
      {
        run: renderCount,
        repeatedInput: repeated,
        inChars: markdown.length,
        outChars: sanitized.length,
        images: imageCount,
        mathTokens: mathTokens.length,
        pipelineMs: +(performance.now() - startedAt).toFixed(1),
        stages: stagesSummary(stages)
      },
      `[PERF][markdown-render] #${renderCount}${repeated ? ' (REPEATED INPUT)' : ''} ` +
        `in=${markdown.length.toLocaleString()}c out=${sanitized.length.toLocaleString()}c ` +
        `imgs=${imageCount} pipeline=${(performance.now() - startedAt).toFixed(0)}ms | ${stagesSummary(stages)}`
    );

    // Render→paint is what the student actually waits for: it includes the DOM
    // update, style recalc and layout the pipeline timing above cannot see.
    afterPaint(() => {
      const paintMs = +(performance.now() - startedAt).toFixed(1);
      const assets = assetReport();
      perf(
        'markdown-paint',
        { run: renderCount, renderToPaintMs: paintMs, chars: markdown.length, assets },
        `[PERF][markdown-paint] #${renderCount} visible ${paintMs}ms after render started ` +
          `(pipeline ${stagesTotal(stages)}ms · layout/paint ${(paintMs - stagesTotal(stages)).toFixed(0)}ms) · ` +
          `assets: ${assets.requests} req, ${assets.totalMB}MB`
      );
    });

    return sanitized;
  });

  function sanitizeRenderedHtml(dirty: string): string {    if (typeof window === 'undefined') return dirty;
    const purify = typeof DOMPurify.sanitize === 'function' ? DOMPurify : (DOMPurify as any)(window);
    if (!purify || typeof purify.sanitize !== 'function') return dirty;
    return purify.sanitize(dirty, {
      ADD_TAGS: ['details', 'summary', 'mark'],
      ADD_ATTR: [
        'target',
        'data-action',
        'data-scale',
        'data-query',
        'data-target',
        'data-note-id',
        'data-anchor-id'
      ]
    });
  }

  function highlightTargetInContainer(container: HTMLElement, targetText: string, noteId: string) {
    const cleanTarget = targetText.trim();
    if (!cleanTarget || cleanTarget.length < 2) return;

    const walker = document.createTreeWalker(
      container,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          if (
            parent.closest('.postit-container') ||
            parent.closest('pre') ||
            parent.closest('code') ||
            parent.closest('mark.ai-note-anchor')
          ) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    const textNodes: Text[] = [];
    let currentNode = walker.nextNode();
    while (currentNode) {
      textNodes.push(currentNode as Text);
      currentNode = walker.nextNode();
    }

    // 1. Try exact substring match across text nodes
    for (const node of textNodes) {
      const val = node.nodeValue || '';
      const idx = val.indexOf(cleanTarget);
      if (idx !== -1) {
        const matchNode = node.splitText(idx);
        matchNode.splitText(cleanTarget.length);
        const mark = document.createElement('mark');
        mark.className = 'ai-note-anchor';
        mark.setAttribute('data-note-id', noteId);
        mark.title = 'Click to jump to AI note';
        mark.textContent = matchNode.nodeValue;
        matchNode.parentNode?.replaceChild(mark, matchNode);
        return;
      }
    }

    // 2. Fallback: match by the opening words of the phrase if soft-wrapped
    const words = cleanTarget.split(/\s+/).filter(Boolean);
    if (words.length >= 2) {
      const snippet = words.slice(0, 4).join(' ');
      for (const node of textNodes) {
        const val = node.nodeValue || '';
        const idx = val.indexOf(snippet);
        if (idx !== -1) {
          const matchNode = node.splitText(idx);
          matchNode.splitText(snippet.length);
          const mark = document.createElement('mark');
          mark.className = 'ai-note-anchor';
          mark.setAttribute('data-note-id', noteId);
          mark.title = 'Click to jump to AI note';
          mark.textContent = matchNode.nodeValue;
          matchNode.parentNode?.replaceChild(mark, matchNode);
          return;
        }
      }
    }
  }

  function setupNoteInteractions() {
    if (!containerEl) return;

    const postits = containerEl.querySelectorAll<HTMLElement>('.postit-container');
    postits.forEach((postit) => {
      const noteId = postit.getAttribute('data-note-id');
      const target = postit.getAttribute('data-target');
      if (!noteId) return;

      if (target) {
        highlightTargetInContainer(containerEl!, target, noteId);
      }

      const anchor = containerEl!.querySelector<HTMLElement>(`mark.ai-note-anchor[data-note-id="${noteId}"]`);
      const details = postit.querySelector<HTMLDetailsElement>('details.postit-card');

      if (anchor && details) {
        // Hover post-it -> highlight anchor
        postit.addEventListener('mouseenter', () => {
          anchor.classList.add('ai-note-anchor-active');
        });
        postit.addEventListener('mouseleave', () => {
          if (!details.open) {
            anchor.classList.remove('ai-note-anchor-active');
          }
        });

        // Hover anchor -> ring post-it
        anchor.addEventListener('mouseenter', () => {
          postit.classList.add('ring-2', 'ring-amber-400');
        });
        anchor.addEventListener('mouseleave', () => {
          postit.classList.remove('ring-2', 'ring-amber-400');
        });

        // Click anchor -> open details and scroll to post-it
        anchor.addEventListener('click', () => {
          details.open = true;
          anchor.classList.add('ai-note-anchor-open');
          postit.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        });

        // Toggle details -> sync anchor open class
        details.addEventListener('toggle', () => {
          if (details.open) {
            anchor.classList.add('ai-note-anchor-open');
          } else {
            anchor.classList.remove('ai-note-anchor-open');
          }
        });
      }
    });
  }

  function handleContainerClick(e: MouseEvent) {
    const targetEl = e.target as HTMLElement;

    // 1. Delete AI Study Note
    const delBtn = targetEl.closest('[data-action="delete-note"]');
    if (delBtn) {
      e.preventDefault();
      e.stopPropagation();
      const query = delBtn.getAttribute('data-query') || '';
      const target = delBtn.getAttribute('data-target') || '';
      confirmDialog('Delete this AI study note?', 'Delete Study Note').then((confirmed) => {
        if (confirmed) {
          onDeleteNote?.(target, query);
        }
      });
      return;
    }

    // 2. Interactive Image Sizing Chip
    const scaleBtn = targetEl.closest('[data-action="scale-img"]');
    if (scaleBtn) {
      e.preventDefault();
      e.stopPropagation();
      const scale = scaleBtn.getAttribute('data-scale') || 'auto';
      const container = scaleBtn.closest('.image-container');
      const img = container?.querySelector<HTMLImageElement>('img.image-resizable');
      if (img) {
        if (scale === 'auto') {
          img.style.width = '';
          img.style.maxHeight = '480px';
          img.style.height = 'auto';
        } else {
          img.style.width = scale;
          img.style.maxWidth = '100%';
          img.style.maxHeight = 'none';
          img.style.height = 'auto';
        }

        // Highlight active scale button in this toolbar
        const chips = container?.querySelectorAll<HTMLElement>('.scale-chip');
        chips?.forEach((c) => {
          c.classList.remove('bg-amber-500', 'text-white', 'font-semibold');
          c.classList.add('text-stone-300');
        });
        scaleBtn.classList.remove('text-stone-300');
        scaleBtn.classList.add('bg-amber-500', 'text-white', 'font-semibold');
      }
      return;
    }

    // 3. View Fullscreen Image in Document Viewer
    const viewBtn = targetEl.closest('[data-action="view-fullscreen"]');
    if (viewBtn) {
      e.preventDefault();
      e.stopPropagation();
      const container = viewBtn.closest('.image-container');
      const img = container?.querySelector<HTMLImageElement>('img.image-resizable');
      if (img && img.src) {
        onOpenDocument?.(img.src, img.alt || 'Image Preview');
      }
      return;
    }

    // 4. Direct click on resizable image (zoom into modal viewer)
    const targetImg = targetEl.closest('img.image-resizable') as HTMLImageElement | null;
    if (targetImg && targetImg.src) {
      const anchor = targetImg.closest('a');
      if (!anchor) {
        e.preventDefault();
        e.stopPropagation();
        onOpenDocument?.(targetImg.src, targetImg.alt || 'Image Preview');
        return;
      }
    }

    // 5. Document / External Link Navigation
    const link = targetEl.closest('a');
    if (link) {
      const href = link.getAttribute('href');
      if (!href) return;

      // Ignore pure internal hash anchors on the same page
      if (href.startsWith('#')) return;

      const isDoc =
        /\.(pdf|docx?|xlsx?|pptx?|txt|png|jpe?g|gif|webp|svg)($|\?)/i.test(href) ||
        href.includes('/assets/locker_docs/') ||
        href.includes('/assets/');

      if (isDoc) {
        e.preventDefault();
        e.stopPropagation();
        const linkTitle = link.textContent?.trim() || link.getAttribute('title') || '';
        onOpenDocument?.(href, linkTitle);
        return;
      }

      // External web links: open in new tab
      if (href.startsWith('http://') || href.startsWith('https://')) {
        link.setAttribute('target', '_blank');
        link.setAttribute('rel', 'noopener noreferrer');
      }
    }
  }

  $effect(() => {
    if (renderedHtml && containerEl) {
      const timer = setTimeout(() => {
        setupNoteInteractions();
      }, 20);
      return () => clearTimeout(timer);
    }
  });
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="relative w-full max-w-full min-w-0">
  <div
    bind:this={containerEl}
    onclick={handleContainerClick}
    class="markdown-body relative prose prose-stone dark:prose-invert max-w-none prose-headings:font-semibold prose-h1:text-2xl prose-h2:text-xl prose-h2:border-b prose-h2:border-stone-200 dark:prose-h2:border-stone-800 prose-h2:pb-2 prose-h3:text-lg prose-p:leading-relaxed prose-img:rounded-lg prose-img:border prose-img:border-stone-200 dark:prose-img:border-stone-800 prose-img:my-4 prose-table:border prose-table:border-stone-200 dark:prose-table:border-stone-800 prose-th:bg-stone-50 dark:prose-th:bg-stone-900 prose-th:px-3 prose-th:py-2 prose-td:px-3 prose-td:py-2 w-full max-w-full min-w-0 break-words [overflow-wrap:anywhere]"
  >
    {@html renderedHtml}
  </div>
  {#if markupFile}
    <MarkupLayer {courseId} file={markupFile} scrollerEl={markupScroller} {containerEl} />
  {/if}
</div>

<style>
  :global(.postit-card summary::-webkit-details-marker),
  :global(.postit-card summary::marker) {
    display: none;
  }

  :global(.ai-note-anchor) {
    background-color: rgba(254, 240, 138, 0.45);
    border-bottom: 2px dotted #d97706;
    border-radius: 2px;
    padding: 0 2px;
    cursor: pointer;
    transition: all 0.15s ease-in-out;
    color: inherit;
  }

  :global(.dark .ai-note-anchor) {
    background-color: rgba(245, 158, 11, 0.15);
    border-bottom: 2px dotted rgba(245, 158, 11, 0.5);
  }

  :global(.ai-note-anchor:hover),
  :global(.ai-note-anchor.ai-note-anchor-active) {
    background-color: rgba(253, 224, 71, 0.85);
    border-bottom-style: solid;
    box-shadow: 0 0 0 2px rgba(251, 191, 36, 0.45);
  }

  :global(.dark .ai-note-anchor:hover),
  :global(.dark .ai-note-anchor.ai-note-anchor-active) {
    background-color: rgba(245, 158, 11, 0.28);
    border-bottom-style: solid;
    box-shadow: 0 0 0 2px rgba(245, 158, 11, 0.2);
  }

  :global(.ai-note-anchor.ai-note-anchor-open) {
    background-color: rgba(254, 240, 138, 0.75);
    border-bottom-style: solid;
  }

  :global(.dark .ai-note-anchor.ai-note-anchor-open) {
    background-color: rgba(245, 158, 11, 0.24);
    border-bottom-style: solid;
  }

  /* Don't show floating toolbar if image is an anchor button */
  :global(a .image-toolbar) {
    display: none !important;
  }

  :global(a .image-resizable) {
    cursor: pointer !important;
  }

  :global(a .image-container) {
    display: inline-block;
    margin: 0.25rem 0;
  }

  :global(.markdown-section) {
    position: relative;
    max-width: 100% !important;
    min-width: 0 !important;
    overflow-wrap: anywhere;
    word-break: break-word;
  }

  /* Robust horizontal overflow containment for markdown elements */
  :global(.markdown-body) {
    max-width: 100% !important;
    min-width: 0 !important;
    overflow-wrap: anywhere !important;
    word-break: break-word !important;
  }

  :global(.markdown-body p),
  :global(.markdown-body li),
  :global(.markdown-body blockquote) {
    overflow-wrap: anywhere;
    word-break: break-word;
  }

  :global(.markdown-body a) {
    overflow-wrap: anywhere;
    word-break: break-all;
  }

  /* Tables: block display with horizontal scroll on small screens prevents layout blowout */
  :global(.markdown-body table) {
    display: block !important;
    width: 100% !important;
    max-width: 100% !important;
    overflow-x: auto !important;
    -webkit-overflow-scrolling: touch;
    box-sizing: border-box !important;
  }

  /* Code blocks: ensure horizontal scroll within container */
  :global(.markdown-body pre) {
    max-width: 100% !important;
    overflow-x: auto !important;
    -webkit-overflow-scrolling: touch;
    box-sizing: border-box !important;
  }

  :global(.markdown-body code) {
    overflow-wrap: anywhere;
    word-break: break-word;
  }

  :global(.markdown-body pre code) {
    overflow-wrap: normal;
    word-break: normal;
    white-space: pre;
  }

  /* Math display formulas */
  :global(.katex-display) {
    max-width: 100% !important;
    overflow-x: auto !important;
    overflow-y: hidden !important;
    -webkit-overflow-scrolling: touch;
    padding: 0.25rem 0 !important;
  }

  :global(.katex) {
    max-width: 100%;
  }

  /* Images: enforce that no image or container exceeds 100% of the viewport width */
  :global(.image-container),
  :global(.image-inner) {
    max-width: 100% !important;
    box-sizing: border-box !important;
  }

  :global(.image-inner img),
  :global(.image-resizable) {
    max-width: 100% !important;
    height: auto !important;
    box-sizing: border-box !important;
  }

  /* Hide floating image toolbar on mobile viewports to prevent phantom horizontal width bleed */
  @media (max-width: 640px) {
    :global(.image-toolbar) {
      display: none !important;
    }
  }
</style>
