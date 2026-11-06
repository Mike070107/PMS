/** Photo evidence belongs to the original photo, independently of OCR success. */
export interface MeterCaptureEvidence {
  photoSource: 'camera' | 'album';
  locationSource: 'device' | 'photo_exif' | 'none';
  locationStatus: 'ready' | 'missing' | 'unreadable' | 'unsupported' | 'failed';
  photoTimeSource: 'device' | 'exif' | 'unknown';
  photoTakenAt: string | null;
  photoTakenAtIso: string | null;
  locationCapturedAt: string | null;
  originalLatitude: number | null;
  originalLongitude: number | null;
}
export function readMeterCaptureEvidence(value: unknown): MeterCaptureEvidence | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (!['camera','album'].includes(String(v.photoSource)) || !['device','photo_exif','none'].includes(String(v.locationSource)) ||
    !['ready','missing','unreadable','unsupported','failed'].includes(String(v.locationStatus)) || !['device','exif','unknown'].includes(String(v.photoTimeSource))) return null;
  if ((v.photoSource === 'album' && v.locationSource === 'device') || (v.photoSource === 'camera' && v.locationSource === 'photo_exif')) return null;
  const text = (x: unknown) => x == null ? null : typeof x === 'string' && x.length <= 64 ? x : undefined;
  const iso = (x: unknown) => { const s = text(x); return s === null || (s && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(s) && Number.isFinite(Date.parse(s))) ? s : undefined; };
  const photoTakenAt = text(v.photoTakenAt), photoTakenAtIso = iso(v.photoTakenAtIso), locationCapturedAt = iso(v.locationCapturedAt);
  if (photoTakenAt === undefined || photoTakenAtIso === undefined || locationCapturedAt === undefined) return null;
  const coordinate = (x: unknown, limit: number) => x == null ? null : typeof x === 'number' && Number.isFinite(x) && Math.abs(x) <= limit ? x : undefined;
  const originalLatitude = coordinate(v.originalLatitude,90), originalLongitude = coordinate(v.originalLongitude,180);
  if (originalLatitude === undefined || originalLongitude === undefined || (originalLatitude === null) !== (originalLongitude === null)) return null;
  if (v.locationSource === 'photo_exif' && (originalLatitude === null || originalLongitude === null)) return null;
  if ((v.locationSource === 'none') === (v.locationStatus === 'ready')) return null;
  return { photoSource:v.photoSource as MeterCaptureEvidence['photoSource'], locationSource:v.locationSource as MeterCaptureEvidence['locationSource'],
    locationStatus:v.locationStatus as MeterCaptureEvidence['locationStatus'], photoTimeSource:v.photoTimeSource as MeterCaptureEvidence['photoTimeSource'],
    photoTakenAt, photoTakenAtIso, locationCapturedAt, originalLatitude, originalLongitude };
}
export function captureLocationLabel(evidence: MeterCaptureEvidence | null | undefined): string {
  if (!evidence) return '历史记录（定位来源未记录）';
  if (evidence.locationSource === 'photo_exif') return '照片 GPS（EXIF）';
  if (evidence.locationSource === 'device') return '现场手机定位';
  return evidence.photoSource === 'album' ? evidence.locationStatus === 'missing' ? '照片无定位' : '照片定位未能读取' : '未获取现场定位';
}
export function captureTimeLabel(evidence: MeterCaptureEvidence | null | undefined): string {
  if (!evidence?.photoTakenAt) return '照片拍摄时间未记录';
  return evidence.photoTimeSource === 'exif' ? `${evidence.photoTakenAt}（EXIF${evidence.photoTakenAtIso ? '' : '，时区未记录'}）` : evidence.photoTakenAt;
}
