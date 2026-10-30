// app/src/lib/edgeIndent.ts

export interface EdgeIndentOptions {
  /**
   * Minimum distance in pixels from the viewport edges. Defaults to 16px.
   */
  minMargin?: number;
  /**
   * Whether this is a cascading submenu that should flip horizontally if there's no room on the left.
   */
  isSubmenu?: boolean;
}

/**
 * Svelte action that ensures floating dropdown menus and submenus
 * are never cut off by viewport edges, keeping them indented by at least minMargin.
 */
export function edgeIndent(node: HTMLElement, options: EdgeIndentOptions = {}) {
  const minMargin = options.minMargin ?? 16;

  function adjust() {
    if (typeof window === 'undefined' || !node || !node.isConnected) return;

    // Reset previous shift
    node.style.translate = '0px 0px';

    if (options.isSubmenu && node.parentElement) {
      const parentRect = node.parentElement.getBoundingClientRect();
      const nodeWidth = node.offsetWidth || 192;
      const spaceOnLeft = parentRect.left;
      const spaceOnRight = window.innerWidth - parentRect.right;

      if (window.innerWidth >= 640) {
        // Desktop / tablet:
        if (spaceOnLeft < nodeWidth + minMargin && spaceOnRight >= nodeWidth + minMargin) {
          // Left side would cut off, but right side has room -> open to the right
          node.style.left = 'calc(100% + 6px)';
          node.style.right = 'auto';
          node.style.top = '0px';
        } else if (spaceOnLeft >= nodeWidth + minMargin) {
          // Room on left -> open to the left
          node.style.left = 'auto';
          node.style.right = 'calc(100% + 6px)';
          node.style.top = '0px';
        } else {
          // Tight on both sides -> drop down below
          node.style.left = 'auto';
          node.style.right = '0px';
          node.style.top = 'calc(100% + 4px)';
        }
      } else {
        // Mobile screen: drop down below
        node.style.left = 'auto';
        node.style.right = '0px';
        node.style.top = 'calc(100% + 4px)';
      }
    }

    // Measure bounding box relative to viewport
    const rect = node.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let shiftX = 0;
    let shiftY = 0;

    // Always ensure indented from left edge
    if (rect.left < minMargin) {
      shiftX = minMargin - rect.left;
    }
    // Always ensure indented from right edge
    else if (rect.right > vw - minMargin) {
      shiftX = (vw - minMargin) - rect.right;
    }

    // Always ensure indented from bottom edge
    if (rect.bottom > vh - minMargin) {
      shiftY = (vh - minMargin) - rect.bottom;
    }

    if (shiftX !== 0 || shiftY !== 0) {
      node.style.translate = `${shiftX}px ${shiftY}px`;
    }
  }

  adjust();
  const rafId = requestAnimationFrame(adjust);

  window.addEventListener('resize', adjust);
  window.addEventListener('scroll', adjust, true);

  return {
    update(newOptions?: EdgeIndentOptions) {
      if (newOptions) Object.assign(options, newOptions);
      adjust();
    },
    destroy() {
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', adjust);
      window.removeEventListener('scroll', adjust, true);
    }
  };
}
