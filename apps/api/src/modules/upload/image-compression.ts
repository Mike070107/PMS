import sharp from 'sharp';

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);
const MIN_BYTES = 32 * 1024;
const MAX_EDGE = 2048;

function isAnimatedPng(buffer: Buffer): boolean {
  // libvips may expose only the default PNG frame; inspect APNG's pre-IDAT animation control chunk.
  for (let offset = 8; offset + 12 <= buffer.length;) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    if (type === 'acTL') return true;
    if (type === 'IDAT' || length > buffer.length - offset - 12) return false;
    offset += length + 12;
  }
  return false;
}

/** The shared /upload route covers miniapps and Web. Never recode videos, PDFs or animated images. */
export async function compressUploadedImage(buffer: Buffer, contentType: string, filename: string) {
  const original = { buffer, contentType, filename };
  if (!IMAGE_TYPES.has(contentType) || buffer.length < MIN_BYTES || (contentType === 'image/png' && isAnimatedPng(buffer))) return original;
  try {
    // Bound decoded pixels as well as the HTTP byte limit; strip EXIF/location metadata after auto-rotation.
    const image = sharp(buffer, { limitInputPixels: 40_000_000, animated: true });
    const metadata = await image.metadata();
    if ((metadata.pages || 1) > 1) return original;
    const encoded = await image.rotate().resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82, effort: 3 }).timeout({ seconds: 8 }).toBuffer();
    if (encoded.length >= buffer.length) return original;
    return { buffer: encoded, contentType: 'image/webp', filename: `${filename.replace(/\.[^.\\/]+$/, '') || 'image'}.webp` };
  } catch {
    // Unsupported HEIC codecs/corrupt images must not make an otherwise accepted business upload disappear.
    return original;
  }
}
