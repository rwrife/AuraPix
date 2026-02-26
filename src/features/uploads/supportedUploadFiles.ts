const RAW_FILE_EXTENSIONS = new Set([
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
]);

function extensionOf(filename: string): string {
  const parts = filename.toLowerCase().split('.');
  return parts.length > 1 ? parts.at(-1) ?? '' : '';
}

export function isSupportedUploadFile(file: Pick<File, 'name' | 'type'>): boolean {
  if (file.type.startsWith('image/')) return true;
  if (RAW_MIME_TYPES.has(file.type.toLowerCase())) return true;
  return RAW_FILE_EXTENSIONS.has(extensionOf(file.name));
}

export function uploadAcceptValue(): string {
  return 'image/*,.dng,.cr2,.cr3,.nef,.arw,.rw2,.orf,.raf';
}
