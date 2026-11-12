/**
 * Utilities for processing and preparing images for storage in course locker_docs.
 */

/**
 * Generates a unique, compact filename starting with the lesson prefix.
 * e.g. '01.01_m7xyz12abc.jpg'
 */
export function generateLockerDocFilename(lessonId?: string): string {
  const rawPrefix = lessonId && lessonId.trim() ? lessonId.trim() : 'course';
  // Keep only alphanumeric characters, dots, underscores, and hyphens
  const prefix = rawPrefix.replace(/[^a-zA-Z0-9._-]/g, '_');

  // Base36 timestamp is compact and strictly monotonic
  const base36Timestamp = Date.now().toString(36);
  // Short 3-char random alphanumeric suffix to guarantee uniqueness even if pasted in rapid succession
  const randomSuffix = Math.random().toString(36).substring(2, 5);

  return `${prefix}_${base36Timestamp}${randomSuffix}.jpg`;
}

export const MAX_PASTE_IMAGE_WIDTH = 1024;

/**
 * Converts an image File or Blob into a compressed JPEG Blob with 70% quality
 * and clamps width to maxWidth (default 1024px, aspect preserved).
 * Paints transparent areas over an opaque white background to prevent dark
 * or inverted backgrounds on transparent PNG screenshots.
 */
export async function compressImageToJpeg(
  fileOrBlob: Blob,
  quality = 0.7,
  maxWidth = MAX_PASTE_IMAGE_WIDTH
): Promise<Blob> {
  // If running in a non-browser environment (e.g. tests without DOM canvas), return as-is
  if (typeof window === 'undefined' || typeof document === 'undefined' || typeof Image === 'undefined') {
    return fileOrBlob;
  }

  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(fileOrBlob);
    const img = new Image();

    img.onload = () => {
      try {
        URL.revokeObjectURL(url);
        const naturalWidth = img.naturalWidth || img.width;
        const naturalHeight = img.naturalHeight || img.height;
        let targetWidth = naturalWidth;
        let targetHeight = naturalHeight;
        if (targetWidth > maxWidth) {
          targetHeight = Math.round(targetHeight * (maxWidth / targetWidth));
          targetWidth = maxWidth;
        }

        const canvas = document.createElement('canvas');
        canvas.width = targetWidth;
        canvas.height = targetHeight;

        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(fileOrBlob);
          return;
        }

        // Fill opaque white background (critical for PNG screenshots with transparency)
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

        canvas.toBlob(
          (blob) => {
            if (blob) {
              resolve(blob);
            } else {
              resolve(fileOrBlob);
            }
          },
          'image/jpeg',
          quality
        );
      } catch (err) {
        URL.revokeObjectURL(url);
        reject(err);
      }
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to load image for JPEG compression'));
    };

    img.src = url;
  });
}
