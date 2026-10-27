import { Facet } from "@codemirror/state";

/**
 * Course ID of the lesson being edited, used to resolve relative asset & image paths.
 */
export const courseIdFacet = Facet.define<string, string>({
  combine: (values) => (values.length ? values[values.length - 1] : ""),
});

/** URL schemes we are willing to hand to an `<a>` or `<img>` element. */
const WEB_URL = /^https?:\/\//i;
const DATA_IMAGE = /^data:image\/[a-z0-9.+-]+;/i;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * The `href` to open for a link. Anything with an unsafe scheme (e.g. javascript:)
 * is dropped.
 */
export function safeExternalHref(url: string): string | null {
  const trimmed = url.trim();
  if (WEB_URL.test(trimmed)) return trimmed;
  if (/^mailto:/i.test(trimmed)) return trimmed;
  if (/^www\./i.test(trimmed)) return `https://${trimmed}`;
  if (trimmed.startsWith("#") || trimmed.startsWith("/")) return trimmed;
  return null;
}

/**
 * Resolves an image source for live preview inside the editor:
 * Web URLs and data URLs pass through directly.
 * Relative course asset paths (`./assets/...` or `assets/...`) resolve to the API route.
 */
export function resolveImageSource(url: string, courseId: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  if (WEB_URL.test(trimmed) || DATA_IMAGE.test(trimmed)) return trimmed;
  if (trimmed.startsWith("/api/")) return trimmed;
  if (HAS_SCHEME.test(trimmed)) return null;

  let clean = trimmed.replace(/^(?:\.{1,2}\/|\/)+/, "");
  if (clean.startsWith("assets/")) {
    clean = clean.slice("assets/".length);
  }

  if (courseId) {
    return `/api/courses/${courseId}/assets/${clean}`;
  }

  return clean.startsWith("/") ? clean : `/assets/${clean}`;
}

import { parseCssImageSpec, type CssImageSpec } from "$lib/markdown/imageSpec";

export type EditorImageSpec = CssImageSpec;

export function parseEditorImageSpec(rawText: string): EditorImageSpec {
  return parseCssImageSpec(rawText);
}
