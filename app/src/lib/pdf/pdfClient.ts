import { registerDejaVuFonts } from './fontLoader';

/**
 * Lazily loads the pdfmake browser bundle (with fonts) the first time a
 * PDF is exported, then caches the configured instance. Keeps pdfmake's
 * ~1.5MB out of the app's startup path entirely.
 */

type PdfMakeClient = Record<string, unknown> & {
  createPdf: (doc: unknown) => { getBlob: () => Promise<Blob>; download: (filename: string) => void };
};

let clientPromise: Promise<PdfMakeClient> | null = null;

export function getPdfMake(): Promise<PdfMakeClient> {
  clientPromise ??= (async () => {
    const mod = (await import('pdfmake/build/pdfmake')) as unknown as {
      default?: PdfMakeClient;
    } & PdfMakeClient;
    const pdfMake: PdfMakeClient = mod.default ?? mod;
    await registerDejaVuFonts(pdfMake as Parameters<typeof registerDejaVuFonts>[0]);
    return pdfMake;
  })();
  return clientPromise;
}

/**
 * Best-effort engine pre-warm.
 *
 * The first export otherwise pays for everything at once: fetching and
 * encoding ~3.3MB of fonts, then letting fontkit parse all six faces on the
 * first render. Doing a throwaway render here forces that parsing while the
 * user is still reading, so the export click only pays for the real document.
 */
export async function prewarmPdfEngine(): Promise<void> {
  try {
    const pdfMake = await getPdfMake();
    const face = (props: Record<string, unknown>) => ({ text: 'Aa', ...props });
    await (
      pdfMake.createPdf({
        content: [
          face({ font: 'DejaVu' }),
          face({ font: 'DejaVu', bold: true }),
          face({ font: 'DejaVu', italics: true }),
          face({ font: 'DejaVu', bolditalics: true }),
          face({ font: 'DejaVuMono' }),
          face({ font: 'DejaVuMono', bold: true })
        ]
      }) as { getBlob: () => Promise<Blob> }
    ).getBlob();
  } catch {
    // Pre-warming is an optimisation; a failure must never surface.
  }
}

/** Runs {@link prewarmPdfEngine} once the browser is idle. */
export function schedulePdfPrewarm(): void {
  if (typeof window === 'undefined') return;
  const run = () => void prewarmPdfEngine();
  const idle = (window as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number })
    .requestIdleCallback;
  if (typeof idle === 'function') {
    idle(run, { timeout: 4000 });
  } else {
    setTimeout(run, 1500);
  }
}
