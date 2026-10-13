import sansUrl from './assets/DejaVuSans.ttf?url';
import sansBoldUrl from './assets/DejaVuSans-Bold.ttf?url';
import sansObliqueUrl from './assets/DejaVuSans-Oblique.ttf?url';
import sansBoldObliqueUrl from './assets/DejaVuSans-BoldOblique.ttf?url';
import monoUrl from './assets/DejaVuSansMono.ttf?url';
import monoBoldUrl from './assets/DejaVuSansMono-Bold.ttf?url';

/**
 * DejaVu covers every glyph family the course content actually uses
 * (→ ← ⇔ ✓ ✔ ☐ ± × ÷ − ≤ ≥ √ superscripts/subscripts, Greek, ½ ⅓ …),
 * unlike pdfmake's bundled Roboto which lacks arrows and check marks.
 * Fonts are emitted as separate lazy assets — nothing loads until a PDF
 * is actually exported.
 */

const FONT_FILES: Record<string, string> = {
  'DejaVuSans.ttf': sansUrl,
  'DejaVuSans-Bold.ttf': sansBoldUrl,
  'DejaVuSans-Oblique.ttf': sansObliqueUrl,
  'DejaVuSans-BoldOblique.ttf': sansBoldObliqueUrl,
  'DejaVuSansMono.ttf': monoUrl,
  'DejaVuSansMono-Bold.ttf': monoBoldUrl
};

/**
 * The total bundled font payload is ~3.3MB, so how it is encoded matters.
 * `FileReader.readAsDataURL` is a native base64 encoder and avoids blocking
 * the main thread on a character-at-a-time JS loop; the manual path stays as
 * a fallback for environments without FileReader.
 */
async function fetchAsBase64(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load PDF font asset: ${url} (${response.status})`);
  }
  const blob = await response.blob();

  if (typeof FileReader !== 'undefined') {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(new Error(`Failed to read PDF font asset: ${url}`));
      reader.readAsDataURL(blob);
    });
    return dataUrl.slice(dataUrl.indexOf(',') + 1);
  }

  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Registers the DejaVu family (sans + mono) on a pdfmake instance. */
export async function registerDejaVuFonts(pdfMake: {
  addFontContainer?: (container: unknown) => void;
  addVirtualFileSystem?: (vfs: Record<string, string>) => void;
  addFonts?: (fonts: unknown) => void;
  virtualfs?: { writeFileSync: (name: string, content: string, encoding: string) => void };
}): Promise<void> {
  const vfs: Record<string, string> = {};
  await Promise.all(
    Object.entries(FONT_FILES).map(async ([name, url]) => {
      vfs[name] = await fetchAsBase64(url);
    })
  );

  const fonts = {
    DejaVu: {
      normal: 'DejaVuSans.ttf',
      bold: 'DejaVuSans-Bold.ttf',
      italics: 'DejaVuSans-Oblique.ttf',
      bolditalics: 'DejaVuSans-BoldOblique.ttf'
    },
    DejaVuMono: {
      normal: 'DejaVuSansMono.ttf',
      bold: 'DejaVuSansMono-Bold.ttf',
      italics: 'DejaVuSansMono.ttf',
      bolditalics: 'DejaVuSansMono-Bold.ttf'
    }
  };

  if (typeof pdfMake.addFontContainer === 'function') {
    pdfMake.addFontContainer({ vfs, fonts });
  } else if (pdfMake.virtualfs) {
    for (const [name, data] of Object.entries(vfs)) {
      pdfMake.virtualfs.writeFileSync(name, data, 'base64');
    }
    pdfMake.addFonts?.(fonts);
  } else {
    throw new Error('Unsupported pdfmake build: no font registration API');
  }
}
