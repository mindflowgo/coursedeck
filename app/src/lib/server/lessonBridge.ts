/**
 * Injected bridge script for original-format HTML lessons.
 *
 * Runs inside the lesson iframe and provides the parent reader with:
 *  - auto height reporting (incl. Bootstrap accordion toggles)
 *  - link interception (in-page anchors, external links, locker docs,
 *    internal lesson/assignment navigation)
 *  - pointer tracking (mouse move + touch-end) for the floating checkpoint
 *    trigger
 *  - text selection capture with serialized range endpoints
 *  - anchor position queries
 *  - persistent highlight painting inside the iframe
 *
 * Every iframe→parent message carries a per-load `session` token; the parent
 * (HtmlViewer) validates `event.source` plus the session and drops stale or
 * foreign messages. Parent→iframe state-changing messages carry the same
 * token and are ignored on mismatch.
 *
 * The script is intentionally ES5-style: it must run inside decade-old
 * lesson HTML bundles.
 */
export function buildLessonBridgeScript(courseId: string): string {
  return `<style>
    html, body {
      height: auto !important;
      min-height: auto !important;
      overflow-x: hidden !important;
      overflow-y: hidden !important;
    }
  </style>
  <script>
    (function() {
      var courseId = ${JSON.stringify(courseId)};
      var session = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      var CONTEXT_CHARS = 32;

      function post(msg) {
        msg.session = session;
        try { window.parent.postMessage(msg, '*'); } catch (e) {}
      }

      // ── Height reporting ────────────────────────────────────────────────
      var heightTimer = null;
      function sendHeight() {
        var body = document.body;
        if (!body) return;
        // Intrinsic content height: avoid using documentElement viewport dimensions,
        // which match the iframe's outer window and prevent shrinking when
        // accordions or dynamic elements collapse.
        var h = Math.max(
          body.scrollHeight || 0,
          body.offsetHeight || 0,
          body.getBoundingClientRect ? Math.ceil(body.getBoundingClientRect().height) : 0
        );
        var children = body.children;
        if (children && children.length) {
          var bodyTop = body.getBoundingClientRect ? body.getBoundingClientRect().top : 0;
          for (var i = 0; i < children.length; i++) {
            var child = children[i];
            if (child && child.getBoundingClientRect) {
              var r = child.getBoundingClientRect();
              var b = Math.ceil(r.bottom - bodyTop);
              if (b > h) h = b;
            }
          }
        }
        if (h > 50) {
          post({ type: 'courseDeck:lessonHeight', height: h });
        }
      }
      function scheduleHeight(delay) {
        clearTimeout(heightTimer);
        heightTimer = setTimeout(sendHeight, delay || 60);
      }
      window.addEventListener('load', sendHeight);
      window.addEventListener('DOMContentLoaded', sendHeight);
      setTimeout(sendHeight, 100);
      setTimeout(sendHeight, 300);
      setTimeout(sendHeight, 800);
      setTimeout(sendHeight, 2000);

      // ── Link interception (accordions, anchors, external, locker, lessons) ──
      document.addEventListener('click', function(e) {
        var target = e.target;
        var link = target && target.closest ? target.closest('a') : null;
        if (!link) return;

        var href = link.getAttribute('href') || '';
        var dataToggle = link.getAttribute('data-toggle');

        // 1. Accordions & in-page hash anchors
        if (dataToggle === 'collapse' || (href && href.startsWith('#'))) {
          e.preventDefault();
          e.stopPropagation();

          var targetId = (href && href.startsWith('#')) ? href.slice(1) : link.getAttribute('data-target');
          if (targetId && targetId.startsWith('#')) targetId = targetId.slice(1);

          if (targetId) {
            var collapseEl = document.getElementById(targetId);
            if (collapseEl) {
              var isCurrentlyOpen = collapseEl.classList.contains('in');
              var parentSelector = link.getAttribute('data-parent');

              if (parentSelector) {
                var parentEl = document.querySelector(parentSelector);
                if (parentEl) {
                  var siblings = parentEl.querySelectorAll('.panel-collapse.in, .collapse.in');
                  for (var i = 0; i < siblings.length; i++) {
                    siblings[i].classList.remove('in');
                    siblings[i].style.display = 'none';
                  }
                  var siblingLinks = parentEl.querySelectorAll('a[data-toggle="collapse"]');
                  for (var j = 0; j < siblingLinks.length; j++) {
                    siblingLinks[j].classList.add('collapsed');
                    siblingLinks[j].setAttribute('aria-expanded', 'false');
                  }
                }
              }

              if (isCurrentlyOpen) {
                collapseEl.classList.remove('in');
                collapseEl.style.display = 'none';
                link.classList.add('collapsed');
                link.setAttribute('aria-expanded', 'false');
              } else {
                collapseEl.classList.add('in');
                collapseEl.style.display = 'block';
                link.classList.remove('collapsed');
                link.setAttribute('aria-expanded', 'true');
              }

              scheduleHeight(50);
              setTimeout(sendHeight, 250);
            } else {
              var anchorEl = document.getElementById(targetId) || document.querySelector('[name="' + targetId + '"]');
              if (anchorEl) {
                anchorEl.scrollIntoView({ behavior: 'smooth' });
              }
            }
          }
          return false;
        }

        // 2. External web links
        if (href && (href.startsWith('https://') || href.startsWith('http://'))) {
          e.preventDefault();
          e.stopPropagation();
          var extTitle = (link.textContent || '').trim() || link.getAttribute('title') || 'Web Page';
          post({ type: 'courseDeck:openDocument', url: href, title: extTitle, isExternal: true });
          return false;
        }

        // 3. Locker docs / attachments
        if (href && (href.includes('locker_docs/') || href.includes('assets/locker_docs/'))) {
          e.preventDefault();
          e.stopPropagation();
          var filename = href.split('?')[0].split('#')[0].split('/').pop();
          var docUrl = '/api/courses/' + encodeURIComponent(courseId) + '/assets/locker_docs/' + encodeURIComponent(filename);
          var docTitle = (link.textContent || '').trim() || filename;
          post({ type: 'courseDeck:openDocument', url: docUrl, title: docTitle });
          return false;
        }

        // 4. Internal lesson / assignment links
        var cleanPath = href.split('?')[0].split('#')[0];
        var cleanLower = cleanPath.toLowerCase();
        if (cleanLower.endsWith('.html') || cleanLower.endsWith('.htm')) {
          e.preventDefault();
          e.stopPropagation();
          var fname = cleanPath.split('/').pop() || '';
          var lastDot = fname.lastIndexOf('.');
          var stem = lastDot >= 0 ? fname.slice(0, lastDot) : fname;
          var isAssign = cleanPath.toLowerCase().indexOf('assign') >= 0 || stem.toLowerCase().indexOf('assign') >= 0;
          post({
            type: 'courseDeck:navigateLesson',
            courseId: courseId,
            rawTarget: stem,
            isAssignment: isAssign
          });
          return false;
        }
      }, true);

      // ── Pointer tracking → parent floating trigger ─────────────────────
      var lastMoveTime = 0;
      document.addEventListener('mousemove', function(e) {
        var now = Date.now();
        if (now - lastMoveTime < 25) return;
        lastMoveTime = now;
        post({
          type: 'courseDeck:iframeMouseMove',
          clientX: e.clientX,
          clientY: e.clientY,
          pointerType: 'mouse',
          anchor: pointerAnchor(e)
        });
      });

      document.addEventListener('mouseleave', function() {
        post({ type: 'courseDeck:iframeMouseLeave' });
      });

      // Touch: the trigger position commits at release, not during drags
      // (scrolling stays native). pointerup covers touch and pen; pointercancel
      // (browser takes over for scrolling) is ignored.
      document.addEventListener('pointerup', function(e) {
        if (e.pointerType === 'mouse') return;
        post({
          type: 'courseDeck:iframePointerUp',
          clientX: e.clientX,
          clientY: e.clientY,
          pointerType: e.pointerType || 'touch',
          anchor: pointerAnchor(e)
        });
      });

      // ── Selection capture with serialized endpoints ────────────────────
      function textNodesIn(el) {
        var out = [];
        var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        var n = walker.nextNode();
        while (n) { out.push(n); n = walker.nextNode(); }
        return out;
      }

      function nodeTextLength(n) {
        if (n.nodeType === 3) return n.data.length;
        var total = 0;
        for (var c = n.firstChild; c; c = c.nextSibling) total += nodeTextLength(c);
        return total;
      }

      function textBefore(root, target) {
        var total = 0;
        var found = false;
        (function walk(node) {
          if (found || node === target) { if (node === target) found = true; return; }
          if (node.nodeType === 3) { total += node.data.length; return; }
          for (var c = node.firstChild; c; c = c.nextSibling) {
            walk(c);
            if (found) return;
          }
        })(root);
        return total;
      }

      function serializePoint(container, offset) {
        var el = container && (container.nodeType === 3 ? container.parentElement : container);
        if (!el || el.nodeType !== 1) return null;
        var owner = el.closest ? el.closest('[data-anchor-id]') : null;
        if (!owner) return null;
        var charOffset = 0;
        if (container.nodeType === 3) {
          charOffset = textBefore(owner, container) + Math.min(offset, container.data.length);
        } else if (container === owner) {
          var kids = container.childNodes;
          var inner = 0;
          for (var i = 0; i < Math.min(offset, kids.length); i++) inner += nodeTextLength(kids[i]);
          charOffset = inner;
        } else if (container.nodeType === 1) {
          charOffset = textBefore(owner, container);
          var kids2 = container.childNodes;
          for (var k = 0; k < Math.min(offset, kids2.length); k++) charOffset += nodeTextLength(kids2[k]);
        }
        return {
          anchorId: owner.getAttribute('data-anchor-id'),
          charOffset: charOffset,
          _owner: owner
        };
      }

      function pointAt(el, charOffset) {
        var nodes = textNodesIn(el);
        var remaining = Math.max(0, charOffset | 0);
        var last = null;
        for (var i = 0; i < nodes.length; i++) {
          last = nodes[i];
          if (remaining <= last.data.length) return { node: last, offset: remaining };
          remaining -= last.data.length;
        }
        return last ? { node: last, offset: last.data.length } : null;
      }

      function findByEndpoint(ep) {
        return ep && ep.anchorId ? findAnchorBlock(ep.anchorId) : null;
      }

      function findAnchorBlock(id) {
        var blocks = document.querySelectorAll('[data-anchor-id]');
        for (var i = 0; i < blocks.length; i++) if (blocks[i].getAttribute('data-anchor-id') === id) return blocks[i];
        return null;
      }

      function pointerAnchor(e) {
        var el = e.target && e.target.closest ? e.target.closest('[data-anchor-id]') : null;
        if (!el) return null;
        var r = el.getBoundingClientRect();
        var anchor = { type: 'block', blockId: el.getAttribute('data-anchor-id'), yRatio: Math.max(0, Math.min(1, (e.clientY-r.top)/(r.height || 1))) };
        var node = null, offset = 0;
        if (document.caretPositionFromPoint) {
          var p = document.caretPositionFromPoint(e.clientX, e.clientY);
          if (p) { node = p.offsetNode; offset = p.offset; }
        } else if (document.caretRangeFromPoint) {
          var p = document.caretRangeFromPoint(e.clientX, e.clientY);
          if (p) { node = p.startContainer; offset = p.startOffset; }
        }
        if (node && el.contains(node)) {
          var point = serializePoint(node, offset);
          if (point && point.anchorId === anchor.blockId) anchor.charOffset = point.charOffset;
        }
        return anchor;
      }

      function checkpointPageY(cp) {
        if (cp.selection && cp.selection.text) {
          var range = resolveSelection(cp.selection);
          if (!range) return null;
          var rect = range.getBoundingClientRect();
          return rect.height ? rect.top + window.scrollY : null;
        }
        var anchor = cp.anchor || {};
        var block = anchor.blockId ? findAnchorBlock(anchor.blockId) : null;
        if (!block) return null;
        if (typeof anchor.charOffset === 'number') {
          var point = pointAt(block, anchor.charOffset);
          if (point) {
            var range = document.createRange();
            range.setStart(point.node, point.offset);
            range.setEnd(point.node, Math.min(point.node.length, point.offset + 1));
            var rect = range.getBoundingClientRect();
            if (rect.height) return rect.top + window.scrollY;
          }
        }
        var rect = block.getBoundingClientRect();
        return rect.top + window.scrollY + rect.height * (anchor.yRatio || 0);
      }

      function buildIndex(root) {
        var chars = [];
        var points = [];
        var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        var n = walker.nextNode();
        while (n) {
          for (var i = 0; i < n.data.length; i++) {
            chars.push(n.data.charAt(i));
            points.push({ node: n, offset: i });
          }
          n = walker.nextNode();
        }
        return { text: chars.join(''), points: points };
      }

      function normWs(s) {
        return (s || '').replace(/\\s+/g, ' ');
      }

      function findQuoteSpan(idx, quote, prefix, suffix) {
        if (!quote) return -1;
        var occurrences = [];
        var pos = idx.text.indexOf(quote);
        while (pos !== -1 && occurrences.length < 50) {
          occurrences.push(pos);
          pos = idx.text.indexOf(quote, pos + 1);
        }
        if (occurrences.length === 0) return -1;
        if (occurrences.length === 1) return occurrences[0];
        var best = -1;
        var bestScore = 0;
        var tie = false;
        for (var i = 0; i < occurrences.length; i++) {
          var start = occurrences[i];
          var score = 0;
          if (prefix && idx.text.slice(Math.max(0, start - prefix.length), start).endsWith(prefix)) score++;
          if (suffix && idx.text.slice(start + quote.length, start + quote.length + suffix.length).startsWith(suffix)) score++;
          if (score > bestScore) { bestScore = score; best = start; tie = false; }
          else if (score === bestScore && bestScore > 0) { tie = true; }
        }
        if (bestScore === 0 || tie) return -1;
        return best;
      }

      function resolveSelection(sel) {
        if (!sel || !sel.text) return null;
        var body = document.body;
        if (!body) return null;
        // 1. endpoint-based
        var startEl = findByEndpoint(sel.start);
        var endEl = findByEndpoint(sel.end);
        if (startEl && endEl) {
          var sp = pointAt(startEl, sel.start && typeof sel.start.charOffset === 'number' ? sel.start.charOffset : 0);
          var endLen = (endEl.textContent || '').length;
          var ep = pointAt(endEl, sel.end && typeof sel.end.charOffset === 'number' ? sel.end.charOffset : endLen);
          if (sp && ep) {
            try {
              var r = document.createRange();
              r.setStart(sp.node, sp.offset);
              r.setEnd(ep.node, ep.offset);
              if (r.toString() && normWs(r.toString()) === normWs(sel.text)) return r;
            } catch (e) {}
          }
        }
        // 2. quote + context fallback
        var idx = buildIndex(body);
        var at = findQuoteSpan(idx, sel.text, sel.prefix, sel.suffix);
        if (at === -1 && /\\s/.test(sel.text)) {
          // whitespace-relaxed pass
          var relaxed = '';
          var rawStartOf = [];
          var pendingSpace = false;
          for (var i = 0; i < idx.text.length; i++) {
            var ch = idx.text.charAt(i);
            if (/\\s/.test(ch)) {
              if (relaxed.length > 0 && !pendingSpace) pendingSpace = true;
              continue;
            }
            if (pendingSpace) { relaxed += ' '; rawStartOf.push(i); pendingSpace = false; }
            relaxed += ch;
            rawStartOf.push(i);
          }
          var relaxedQuote = normWs(sel.text).trim();
          var findAt = function(hay, needle) {
            var p = hay.indexOf(needle);
            var count = 0;
            var positions = [];
            while (p !== -1 && count < 50) { positions.push(p); count++; p = hay.indexOf(needle, p + 1); }
            if (positions.length === 1) return positions[0];
            return -1;
          };
          var rat = findAt(relaxed, relaxedQuote);
          if (rat !== -1 && rawStartOf[rat] !== undefined) {
            var rawStart2 = rawStartOf[rat];
            var rawEnd2 = rawStartOf[rat + relaxedQuote.length - 1] + 1;
            var nextRaw = rat + relaxedQuote.length < rawStartOf.length ? rawStartOf[rat + relaxedQuote.length] : idx.text.length;
            while (rawEnd2 < nextRaw) rawEnd2++;
            at = rawStart2;
            var spanEnd = rawEnd2;
            if (spanEnd > at) {
              var sp2 = idx.points[at];
              var ep2 = idx.points[spanEnd - 1];
              if (sp2 && ep2) {
                try {
                  var r2 = document.createRange();
                  r2.setStart(sp2.node, sp2.offset);
                  r2.setEnd(ep2.node, ep2.offset + 1);
                  return r2;
                } catch (e2) {}
              }
            }
          }
          return null;
        }
        if (at === -1) return null;
        var sp3 = idx.points[at];
        var ep3 = idx.points[at + sel.text.length - 1];
        if (!sp3 || !ep3) return null;
        try {
          var r3 = document.createRange();
          r3.setStart(sp3.node, sp3.offset);
          r3.setEnd(ep3.node, ep3.offset + 1);
          return r3;
        } catch (e3) {
          return null;
        }
      }

      var hadSelection = false;
      function postCleared() {
        if (hadSelection) {
          hadSelection = false;
          post({ type: 'courseDeck:selectionCleared' });
        }
      }

      function captureSelection(clientX, clientY) {
        var sel = window.getSelection();
        if (!sel || sel.rangeCount === 0 || sel.isCollapsed) { postCleared(); return; }
        var range = sel.getRangeAt(0);
        var text = sel.toString().replace(/\\s+$/, '');
        if (!text.trim()) { postCleared(); return; }
        var start = serializePoint(range.startContainer, range.startOffset);
        var end = serializePoint(range.endContainer, range.endOffset);
        if (!start || !end) { postCleared(); return; }

        var rangeRect = range.getBoundingClientRect();
        var pageY = rangeRect ? rangeRect.top + (window.scrollY || window.pageYOffset || 0) : (clientY || 0);
        var startText = (start._owner.textContent || '');
        var endText = (end._owner.textContent || '');
        var so = start.charOffset || 0;
        var eo = end.charOffset || 0;

        hadSelection = true;
        post({
          type: 'courseDeck:textSelected',
          text: text,
          start: { anchorId: start.anchorId, charOffset: start.charOffset },
          end: { anchorId: end.anchorId, charOffset: end.charOffset },
          prefix: startText.slice(Math.max(0, so - CONTEXT_CHARS), so),
          suffix: endText.slice(eo, eo + CONTEXT_CHARS),
          iframePageY: Math.round(pageY),
          clientX: clientX || 0,
          clientY: clientY || 0
        });
      }

      document.addEventListener('mouseup', function(e) {
        setTimeout(function() { captureSelection(e.clientX, e.clientY); }, 10);
      });
      document.addEventListener('touchend', function(e) {
        var t = e.changedTouches && e.changedTouches[0];
        setTimeout(function() { captureSelection(t ? t.clientX : 0, t ? t.clientY : 0); }, 50);
      });

      var selectionChangeTimer = null;
      document.addEventListener('selectionchange', function() {
        clearTimeout(selectionChangeTimer);
        selectionChangeTimer = setTimeout(function() { captureSelection(0, 0); }, 300);
      });

      // ── Highlight painting ──────────────────────────────────────────────
      var highlightLayer = null;
      var activeHighlights = [];

      function ensureLayer() {
        if (highlightLayer && document.body && document.body.contains(highlightLayer)) return highlightLayer;
        if (!document.body) return null;
        highlightLayer = document.createElement('div');
        highlightLayer.setAttribute('data-coursedeck-highlights', '');
        highlightLayer.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;pointer-events:none;z-index:2147483000;overflow:hidden;';
        document.body.appendChild(highlightLayer);
        var bodyPos = window.getComputedStyle(document.body).position;
        if (bodyPos === 'static') document.body.style.position = 'relative';
        return highlightLayer;
      }

      var renderTimer = null;
      function renderHighlights() {
        clearTimeout(renderTimer);
        renderTimer = setTimeout(function() {
          var layer = ensureLayer();
          if (!layer) return;
          while (layer.firstChild) layer.removeChild(layer.firstChild);
          if (!activeHighlights.length) return;
          var bodyRect = document.body.getBoundingClientRect();
          for (var h = 0; h < activeHighlights.length; h++) {
            var hl = activeHighlights[h];
            var range = resolveSelection(hl.selection);
            if (!range) continue; // stale/ambiguous anchors stay unpainted
            var rects;
            try { rects = range.getClientRects(); } catch (e) { continue; }
            for (var i = 0; i < rects.length; i++) {
              var q = rects[i];
              if (q.width < 1 || q.height < 1) continue;
              var d = document.createElement('div');
              d.style.position = 'absolute';
              d.style.pointerEvents = 'none';
              d.style.borderRadius = '2px';
              d.style.mixBlendMode = 'multiply';
              d.style.backgroundColor = (hl.color || '#f7fa6d') + '55';
              d.style.top = (q.top - bodyRect.top) + 'px';
              d.style.left = (q.left - bodyRect.left) + 'px';
              d.style.width = q.width + 'px';
              d.style.height = q.height + 'px';
              layer.appendChild(d);
            }
          }
        }, 60);
      }

      // Re-resolve highlights whenever the layout changes (accordions,
      // images/fonts loading, resize). The layer's own mutations are ignored.
      var layoutTimer = null;
      function scheduleLayoutRefresh() {
        clearTimeout(layoutTimer);
        layoutTimer = setTimeout(function() {
          scheduleHeight(0);
          renderHighlights();
        }, 120);
      }

      if (window.MutationObserver && document.body) {
        new MutationObserver(function(records) {
          for (var i = 0; i < records.length; i++) {
            var t = records[i].target;
            if (t && t.nodeType === 1 && (t === highlightLayer || (highlightLayer && highlightLayer.contains(t)))) continue;
            scheduleLayoutRefresh();
            return;
          }
        }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
      }
      if (window.ResizeObserver) {
        if (document.body) new ResizeObserver(scheduleLayoutRefresh).observe(document.body);
        if (document.documentElement) new ResizeObserver(scheduleLayoutRefresh).observe(document.documentElement);
      }

      // ── Parent messages: anchor queries + highlight sync ────────────────
      window.addEventListener('message', function(event) {
        if (event.source !== window.parent) return;
        var data = event.data;
        if (!data || typeof data !== 'object') return;
        if (data.session !== undefined && data.session !== session) return;

        if (data.type === 'courseDeck:queryAnchorPositions' && Array.isArray(data.checkpoints)) {
          var positions = {};
          for (var i = 0; i < data.checkpoints.length; i++) {
            var cp = data.checkpoints[i];
            if (!cp || typeof cp.id !== 'string') continue;
            var y = checkpointPageY(cp);
            if (typeof y === 'number' && isFinite(y)) positions[cp.id] = Math.round(y);
          }
          post({ type: 'courseDeck:anchorPositions', positions: positions });
        } else if (data.type === 'courseDeck:applyHighlights' && Array.isArray(data.highlights)) {
          activeHighlights = data.highlights;
          renderHighlights();
        }
      });
    })();
  <\/script>`;
}
