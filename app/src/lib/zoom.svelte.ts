import { isTauriEnvironment } from '$lib/api';
import {
  DEFAULT_ZOOM,
  STORAGE_KEY,
  WHEEL_RESET_MS,
  nextLevel,
  normalizeWheelDelta,
  parseStoredZoom,
  snapToStep,
  stepFromWheel
} from '$lib/zoomLevels';

const INDICATOR_DURATION_MS = 1200;

/**
 * Browser-style page zoom for the desktop app. Applies CSS `zoom` to the
 * document root (pre-paint restore lives in app.html) and is intentionally
 * inert in plain browsers, where native browser zoom already does this job.
 */
class ZoomManager {
  level = $state<number>(DEFAULT_ZOOM);
  indicatorVisible = $state<boolean>(false);

  private enabled = false;
  private wheelAccum = 0;
  private lastWheelAt = 0;
  private indicatorTimer: ReturnType<typeof setTimeout> | null = null;

  init() {
    if (typeof window === 'undefined') return;
    this.enabled = isTauriEnvironment();
    if (!this.enabled) return;

    this.level = parseStoredZoom(localStorage.getItem(STORAGE_KEY));
    this.apply();

    window.addEventListener('keydown', this.onKeydown);
    window.addEventListener('wheel', this.onWheel, { passive: false });
  }

  zoomIn() {
    this.step(1);
  }

  zoomOut() {
    this.step(-1);
  }

  resetZoom() {
    this.setLevel(DEFAULT_ZOOM);
  }

  setLevel(level: number) {
    if (!this.enabled) return;
    const snapped = snapToStep(level);
    if (snapped === this.level) return;

    this.level = snapped;
    this.apply();
    this.persist();
    this.flashIndicator();
  }

  private step(direction: 1 | -1) {
    if (!this.enabled) return;
    const next = nextLevel(this.level, direction);
    if (next === this.level) return;

    this.level = next;
    this.apply();
    this.persist();
    this.flashIndicator();
  }

  private apply() {
    if (typeof document === 'undefined') return;

    if (this.level === DEFAULT_ZOOM) {
      document.documentElement.style.removeProperty('zoom');
    } else {
      document.documentElement.style.zoom = String(this.level / 100);
    }
  }

  private persist() {
    try {
      localStorage.setItem(STORAGE_KEY, String(this.level));
    } catch (_) {
      // Storage unavailable: zoom still works for this session.
    }
  }

  private flashIndicator() {
    this.indicatorVisible = true;
    if (this.indicatorTimer) clearTimeout(this.indicatorTimer);
    this.indicatorTimer = setTimeout(() => {
      this.indicatorVisible = false;
    }, INDICATOR_DURATION_MS);
  }

  private onKeydown = (event: KeyboardEvent) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;

    switch (event.key) {
      case '+':
      case '=':
        event.preventDefault();
        this.zoomIn();
        break;
      case '-':
      case '_':
        event.preventDefault();
        this.zoomOut();
        break;
      case '0':
        event.preventDefault();
        this.resetZoom();
        break;
    }
  };

  private onWheel = (event: WheelEvent) => {
    // Ctrl+wheel is also how engines report trackpad pinch gestures.
    if (!event.ctrlKey) return;
    event.preventDefault();

    const now = performance.now();
    if (now - this.lastWheelAt > WHEEL_RESET_MS) {
      this.wheelAccum = 0;
    }
    this.lastWheelAt = now;

    const result = stepFromWheel(
      this.wheelAccum,
      normalizeWheelDelta(event.deltaY, event.deltaMode)
    );
    this.wheelAccum = result.accum;

    if (result.step === 'in') this.zoomIn();
    else if (result.step === 'out') this.zoomOut();
  };
}

export const zoom = new ZoomManager();
