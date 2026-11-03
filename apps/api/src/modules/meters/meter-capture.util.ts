import { BadRequestException } from '@nestjs/common';

/** Validate untrusted photo provenance before retaining it in the existing OCR JSON evidence. */
export function validateCaptureEvidence(raw: Record<string, unknown> | undefined, latitude?: number, longitude?: number) {
  if (!raw || !Object.prototype.hasOwnProperty.call(raw, 'captureEvidence') || raw.captureEvidence == null) return;
  const value = raw.captureEvidence as Record<string, unknown>;
  const fail = () => { throw new BadRequestException('照片定位来源或拍摄时间无效，请重新选择照片'); };
  if (typeof value !== 'object' || Array.isArray(value)) return fail();
  if (!['camera','album'].includes(String(value.photoSource)) || !['device','photo_exif','none'].includes(String(value.locationSource)) ||
    !['ready','missing','unreadable','unsupported','failed'].includes(String(value.locationStatus)) || !['device','exif','unknown'].includes(String(value.photoTimeSource))) return fail();
  if ((value.photoSource === 'album' && (value.locationSource === 'device' || value.photoTimeSource === 'device')) ||
    (value.photoSource === 'camera' && (value.locationSource === 'photo_exif' || value.photoTimeSource === 'exif'))) return fail();
  const ready = value.locationSource !== 'none';
  if (ready !== (value.locationStatus === 'ready')) return fail();
  const coordinate = (v: unknown, max: number) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= max;
  if (ready ? !coordinate(latitude,90) || !coordinate(longitude,180) : latitude != null || longitude != null) return fail();
  if (value.locationSource === 'photo_exif' ? !coordinate(value.originalLatitude,90) || !coordinate(value.originalLongitude,180) : value.originalLatitude != null || value.originalLongitude != null) return fail();
  for (const field of ['photoTakenAt','photoTakenAtIso','locationCapturedAt']) {
    const text = value[field];
    if (text != null && (typeof text !== 'string' || text.length > 64)) return fail();
    if (text != null && field !== 'photoTakenAt' && (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(String(text)) || !Number.isFinite(Date.parse(String(text))))) return fail();
  }
  if (value.photoTimeSource === 'unknown' && (value.photoTakenAt != null || value.photoTakenAtIso != null)) return fail();
}
