import { resolveImageSource, safeExternalHref } from "./sources";
import { darkenBackgroundForDarkMode, lightenTextForDarkMode, parseCssColor } from "$lib/markdown/darkModeStyles";
import { theme } from "$lib/theme.svelte";

const ALLOWED_TAGS = new Set([
  "a", "abbr", "b", "big", "blockquote", "br", "caption", "cite", "code",
  "col", "colgroup", "dd", "del", "details", "dfn", "div", "dl", "dt", "em",
  "figcaption", "figure", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i",
  "img", "ins", "kbd", "li", "mark", "ol", "p", "picture", "pre", "q", "s",
  "samp", "section", "small", "source", "span", "strong", "sub", "summary",
  "sup", "table", "tbody", "td", "tfoot", "th", "thead", "time", "tr", "u",
  "ul", "video", "wbr",
]);

const ALLOWED_ATTRIBUTES = new Set([
  "align", "alt", "bgcolor", "class", "cite", "colspan", "controls", "datetime", "dir",
  "height", "href", "lang", "loop", "muted", "open", "poster", "reversed",
  "rowspan", "span", "src", "start", "style", "title", "type", "width",
]);

const URL_ATTRIBUTES = new Set(["href", "src", "poster"]);

const SAFE_PROPERTIES = new Set([
  "background", "background-color", "border", "border-bottom", "border-collapse", "border-color",
  "border-left", "border-radius", "border-right", "border-spacing", "border-style",
  "border-top", "border-width", "color", "font-family", "font-size", "font-style",
  "font-variant", "font-weight", "letter-spacing", "line-height", "list-style-type",
  "padding", "padding-bottom", "padding-left", "padding-right", "padding-top",
  "text-align", "text-decoration", "text-transform", "vertical-align", "white-space",
  "word-break", "max-width", "max-height",
]);

const UNSAFE_VALUE = /url\s*\(|expression\s*\(|@import|javascript:|\\|\/\*/i;

function sanitizeStyle(value: string): string | null {
  const kept: string[] = [];

  for (const declaration of value.split(";")) {
    const colon = declaration.indexOf(":");
    if (colon === -1) continue;

    const property = declaration.slice(0, colon).trim().toLowerCase();
    const setting = declaration.slice(colon + 1).trim();

    if (!SAFE_PROPERTIES.has(property)) continue;
    if (!setting || UNSAFE_VALUE.test(setting)) continue;

    // Light inline backgrounds (and dark inline text) would be unreadable
    // against the inverted dark theme; convert them to dark-mode equivalents.
    let finalSetting = setting;
    if (theme.isDark) {
      const important = setting.match(/^(.*?)\s*!important\s*$/i);
      const raw = important ? important[1].trim() : setting;
      const suffix = important ? " !important" : "";
      if (property === "background-color" || property === "background") {
        finalSetting = (darkenBackgroundForDarkMode(raw) ?? raw) + suffix;
      } else if (property === "color") {
        finalSetting = (lightenTextForDarkMode(raw) ?? raw) + suffix;
      }
    }

    kept.push(`${property}: ${finalSetting}`);
  }

  return kept.length ? kept.join("; ") : null;
}

/** Legacy `bgcolor` → a `background-color` declaration so one dark path covers both. */
function normalizeBgcolor(clean: HTMLElement, raw: string): void {
  // Only accept a plain colour: the style sanitizer blocks url()/expression(),
  // and bgcolor must not smuggle those past that check.
  if (!parseCssColor(raw)) return;
  const color = theme.isDark ? darkenBackgroundForDarkMode(raw) ?? raw : raw;
  const existing = clean.getAttribute("style");
  const declaration = `background-color: ${color}`;
  clean.setAttribute("style", existing ? `${existing}; ${declaration}` : declaration);
}

function sanitizeUrl(name: string, value: string, courseId: string): string | null {
  if (name === "href") return safeExternalHref(value);
  return resolveImageSource(value, courseId);
}

const LINK_CLASS = "cm-md-link";
const LINK_HREF = "data-href";

function sanitizeElement(element: Element, courseId: string): HTMLElement | null {
  const tag = element.tagName.toLowerCase();
  if (!ALLOWED_TAGS.has(tag)) return null;

  const isLink = tag === "a";
  const clean = document.createElement(isLink ? "span" : tag);

  for (const attribute of Array.from(element.attributes)) {
    const name = attribute.name.toLowerCase();
    if (!ALLOWED_ATTRIBUTES.has(name)) continue;
    if (isLink && name === "class") continue;
    // Handled after the loop so it can merge into the sanitized style.
    if (name === "bgcolor") continue;

    let value: string | null = attribute.value;
    if (name === "style") value = sanitizeStyle(value);
    else if (URL_ATTRIBUTES.has(name)) value = sanitizeUrl(name, value, courseId);
    if (value === null) continue;

    clean.setAttribute(isLink && name === "href" ? LINK_HREF : name, value);
  }

  const bgcolor = element.getAttribute("bgcolor");
  if (bgcolor) normalizeBgcolor(clean, bgcolor);

  if (isLink && clean.hasAttribute(LINK_HREF)) clean.className = LINK_CLASS;

  return clean;
}

function sanitizeNode(node: Node, courseId: string): Node | null {
  if (node.nodeType === Node.TEXT_NODE) return document.createTextNode(node.nodeValue ?? "");
  if (node.nodeType !== Node.ELEMENT_NODE) return null;

  const clean = sanitizeElement(node as Element, courseId);
  if (!clean) return null;

  for (const child of Array.from(node.childNodes)) {
    const cleanChild = sanitizeNode(child, courseId);
    if (cleanChild) clean.appendChild(cleanChild);
  }

  return clean;
}

export function sanitizeHtml(html: string, courseId: string): DocumentFragment {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const fragment = document.createDocumentFragment();

  for (const child of Array.from(parsed.body.childNodes)) {
    const clean = sanitizeNode(child, courseId);
    if (clean) fragment.appendChild(clean);
  }

  return fragment;
}

export function rendersAnything(fragment: DocumentFragment): boolean {
  return (
    fragment.childNodes.length > 0 &&
    (fragment.textContent?.trim() !== "" || !!fragment.querySelector("*"))
  );
}
