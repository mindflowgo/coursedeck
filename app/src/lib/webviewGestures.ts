/**
 * Webview gesture, viewport scaling, context/edit menu suppression,
 * and drag ghost prevention across iOS (WKWebView / Apple Pencil) and Android (Chromium WebView / Stylus).
 *
 * Gated by input type so desktop Tauri and browser users (mouse & keyboard) retain
 * standard text selection, copy/paste, and native context menus.
 */

function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || (target as HTMLElement).isContentEditable) {
    return true;
  }
  return Boolean(
    target.closest('input, textarea, [contenteditable="true"], [contenteditable=""], .cm-editor, .cm-content')
  );
}

export function initWebviewGestures(): () => void {
  if (typeof window === 'undefined') return () => {};

  // Track the most recent pointer device type ('mouse' | 'touch' | 'pen')
  let lastPointerType = 'mouse';

  // 1. Record input device and handle stylus selection dismissal
  const onPointerDown = (e: PointerEvent) => {
    lastPointerType = e.pointerType || 'mouse';

    // When writing/drawing with a stylus outside editable text fields, clear any existing
    // text selection so callouts/edit balloons don't follow the pen.
    // Note: We deliberately do NOT preventDefault() on pointerdown so focus transitions
    // and PDF markup/annotation canvas interactions continue working cleanly.
    if (e.pointerType === 'pen' && !isEditableElement(e.target)) {
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) {
        sel.removeAllRanges();
      }
    }
  };

  // 2. Prevent text selection triggers on touch / pen (blocks iOS Edit Menu & Android Action Mode)
  // Desktop mouse users (lastPointerType === 'mouse') can freely select text to copy definitions/code.
  const onSelectStart = (e: Event) => {
    if (lastPointerType === 'touch' || lastPointerType === 'pen') {
      if (!isEditableElement(e.target)) {
        e.preventDefault();
      }
    }
  };

  // 3. Fail-safe: if touch / pen initiates an uncollapsed selection outside editable elements, dismiss it
  const onSelectionChange = () => {
    if (lastPointerType === 'touch' || lastPointerType === 'pen') {
      const active = document.activeElement;
      if (!isEditableElement(active)) {
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed) {
          sel.removeAllRanges();
        }
      }
    }
  };

  // 4. Block native context menus on long-press (touch / pen), but preserve context menus
  // for desktop mouse users and inside interactive text inputs (for paste/cut).
  const onContextMenu = (e: MouseEvent) => {
    if (lastPointerType === 'touch' || lastPointerType === 'pen') {
      if (!isEditableElement(e.target)) {
        e.preventDefault();
      }
    }
  };

  // 5. Prevent native drag ghosts for images and links (e.g. pen flicks over diagrams)
  const onDragStart = (e: DragEvent) => {
    const target = e.target;
    if (
      target instanceof Element &&
      (target.tagName === 'IMG' || target.tagName === 'A' || Boolean(target.closest('img, a')))
    ) {
      e.preventDefault();
    }
  };

  // 6. Block WebKit proprietary viewport zoom gestures (pinch-to-zoom on iOS/iPadOS)
  const onGesture = (e: Event) => {
    e.preventDefault();
  };

  window.addEventListener('pointerdown', onPointerDown, { capture: true });
  document.addEventListener('selectstart', onSelectStart, { capture: true });
  document.addEventListener('selectionchange', onSelectionChange);
  window.addEventListener('contextmenu', onContextMenu, { capture: true });
  document.addEventListener('dragstart', onDragStart, { capture: true });
  document.addEventListener('gesturestart', onGesture);
  document.addEventListener('gesturechange', onGesture);
  document.addEventListener('gestureend', onGesture);

  return () => {
    window.removeEventListener('pointerdown', onPointerDown, { capture: true });
    document.removeEventListener('selectstart', onSelectStart, { capture: true });
    document.removeEventListener('selectionchange', onSelectionChange);
    window.removeEventListener('contextmenu', onContextMenu, { capture: true });
    document.removeEventListener('dragstart', onDragStart, { capture: true });
    document.removeEventListener('gesturestart', onGesture);
    document.removeEventListener('gesturechange', onGesture);
    document.removeEventListener('gestureend', onGesture);
  };
}
