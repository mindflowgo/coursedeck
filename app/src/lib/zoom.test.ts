import { describe, it, expect } from 'bun:test';
import {
  DEFAULT_ZOOM,
  MAX_ZOOM,
  MIN_ZOOM,
  STORAGE_KEY,
  WHEEL_STEP_THRESHOLD,
  ZOOM_STEPS,
  nextLevel,
  normalizeWheelDelta,
  parseStoredZoom,
  snapToStep,
  stepFromWheel
} from './zoomLevels';

describe('ladder constants', () => {
  it('exposes the browser-style ladder with 100 as default', () => {
    expect(ZOOM_STEPS).toEqual([50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300]);
    expect(DEFAULT_ZOOM).toBe(100);
    expect(MIN_ZOOM).toBe(50);
    expect(MAX_ZOOM).toBe(300);
    expect(STORAGE_KEY).toBe('course_zoom');
  });
});

describe('snapToStep', () => {
  it('keeps exact ladder values', () => {
    for (const step of ZOOM_STEPS) {
      expect(snapToStep(step)).toBe(step);
    }
  });

  it('snaps off-ladder values to the nearest step', () => {
    expect(snapToStep(102)).toBe(100);
    expect(snapToStep(118)).toBe(125);
    expect(snapToStep(269)).toBe(250);
  });

  it('resolves ties to the lower step', () => {
    expect(snapToStep(105)).toBe(100);
  });

  it('clamps out-of-range values onto the ladder ends', () => {
    expect(snapToStep(1)).toBe(MIN_ZOOM);
    expect(snapToStep(9999)).toBe(MAX_ZOOM);
  });
});

describe('parseStoredZoom', () => {
  it('defaults when nothing is stored', () => {
    expect(parseStoredZoom(null)).toBe(DEFAULT_ZOOM);
  });

  it('defaults on junk and non-positive values', () => {
    expect(parseStoredZoom('banana')).toBe(DEFAULT_ZOOM);
    expect(parseStoredZoom('')).toBe(DEFAULT_ZOOM);
    expect(parseStoredZoom('0')).toBe(DEFAULT_ZOOM);
    expect(parseStoredZoom('-150')).toBe(DEFAULT_ZOOM);
  });

  it('accepts stored ladder values', () => {
    expect(parseStoredZoom('125')).toBe(125);
    expect(parseStoredZoom('50')).toBe(50);
  });

  it('snaps stored off-ladder values', () => {
    expect(parseStoredZoom('112')).toBe(110);
    expect(parseStoredZoom('900')).toBe(MAX_ZOOM);
    expect(parseStoredZoom('12')).toBe(MIN_ZOOM);
  });
});

describe('nextLevel', () => {
  it('moves one step in each direction', () => {
    expect(nextLevel(100, 1)).toBe(110);
    expect(nextLevel(100, -1)).toBe(90);
    expect(nextLevel(150, 1)).toBe(175);
    expect(nextLevel(150, -1)).toBe(125);
  });

  it('clamps at both ends', () => {
    expect(nextLevel(MAX_ZOOM, 1)).toBe(MAX_ZOOM);
    expect(nextLevel(MIN_ZOOM, -1)).toBe(MIN_ZOOM);
  });

  it('snaps its input before stepping', () => {
    expect(nextLevel(104, 1)).toBe(110);
  });

  it('can walk the entire ladder up and back down', () => {
    let level = MIN_ZOOM;
    const up: number[] = [level];
    for (let i = 0; i < ZOOM_STEPS.length + 3; i++) {
      level = nextLevel(level, 1);
      up.push(level);
    }
    expect(up[up.length - 1]).toBe(MAX_ZOOM);
    expect(new Set(up)).toEqual(new Set(ZOOM_STEPS));
  });
});

describe('stepFromWheel', () => {
  it('steps once on a single mouse notch and empties the accumulator', () => {
    // Scrolling up (negative deltaY) zooms in.
    expect(stepFromWheel(0, -100)).toEqual({ accum: 0, step: 'in' });
    expect(stepFromWheel(0, 100)).toEqual({ accum: 0, step: 'out' });
  });

  it('accumulates small deltas until the threshold is crossed', () => {
    let accum = 0;
    let steps = 0;
    for (let i = 0; i < 10; i++) {
      const result = stepFromWheel(accum, -5);
      accum = result.accum;
      if (result.step !== 0) steps++;
    }
    // 10 * 5px = 50px of delta crosses the 40px threshold exactly once.
    expect(steps).toBe(1);
    expect(accum).toBeLessThan(WHEEL_STEP_THRESHOLD);
  });

  it('resets accumulation when the scroll direction reverses', () => {
    const partial = stepFromWheel(0, -30);
    expect(partial.step).toBe(0);
    // Reversal discards the -30px; +30 alone is below the threshold.
    const reversed = stepFromWheel(partial.accum, 30);
    expect(reversed.step).toBe(0);
    expect(reversed.accum).toBe(30);
  });

  it('does not step on deltas below the threshold', () => {
    expect(stepFromWheel(0, 39)).toEqual({ accum: 39, step: 0 });
  });
});

describe('normalizeWheelDelta', () => {
  it('passes pixel deltas through', () => {
    expect(normalizeWheelDelta(120, 0)).toBe(120);
  });

  it('scales line and page mode deltas', () => {
    expect(normalizeWheelDelta(3, 1)).toBe(48);
    expect(normalizeWheelDelta(2, 2)).toBe(200);
  });
});
