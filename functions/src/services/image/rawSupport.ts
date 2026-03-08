import exifr from 'exifr';

const RAW_EXTENSIONS = new Set([
  'dng',
  'cr2',
  'cr3',
  'nef',
  'arw',
  'rw2',
  'orf',
  'raf',
]);

const RAW_MIME_TYPES = new Set([
  'image/x-adobe-dng',
  'image/x-canon-cr2',
  'image/x-canon-cr3',
  'image/x-nikon-nef',
  'image/x-sony-arw',
  'image/x-panasonic-rw2',
  'image/x-olympus-orf',
  'image/x-fuji-raf',
  'application/x-raw-image',
  'application/octet-stream',
]);

export function fileExtension(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase();
  return ext || '';
}

export function isRawUpload(fileName: string, mimeType?: string): boolean {
  const normalizedMime = mimeType?.toLowerCase() || '';
  if (RAW_MIME_TYPES.has(normalizedMime)) return true;
  return RAW_EXTENSIONS.has(fileExtension(fileName));
}

/**
 * Best-effort decode source for RAW files by using embedded preview/thumbnail.
 */
export async function extractRawPreviewBuffer(inputBuffer: Buffer): Promise<Buffer | null> {
  const preview = await exifr.thumbnail(inputBuffer);
  if (!preview) return null;

  if (preview instanceof Uint8Array) {
    return Buffer.from(preview);
  }

  return Buffer.from(preview as ArrayBuffer);
}
