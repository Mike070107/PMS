import { parse } from './vendor/exifr';

export interface PhotoMetadata {
  status: 'ready' | 'missing' | 'unreadable' | 'unsupported';
  latitude?: number; longitude?: number; accuracy?: number;
  photoTakenAt: string | null; photoTakenAtIso: string | null;
}
const empty = (status: PhotoMetadata['status']): PhotoMetadata => ({ status, photoTakenAt: null, photoTakenAtIso: null });
function photoTime(date: unknown, offset: unknown): { photoTakenAt: string | null; photoTakenAtIso: string | null } {
  const match = typeof date === 'string' ? date.trim().match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/) : null;
  if (!match) return { photoTakenAt: null, photoTakenAtIso: null };
  const [year,month,day,hour,minute,second] = match.slice(1).map(Number);
  const check = new Date(Date.UTC(year,month-1,day,hour,minute,second));
  if (year < 1900 || check.getUTCFullYear()!==year || check.getUTCMonth()!==month-1 || check.getUTCDate()!==day || hour>23 || minute>59 || second>59) return {photoTakenAt:null,photoTakenAtIso:null};
  const local = `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}:${match[6]}`;
  const zone = typeof offset === 'string' && /^[+-](?:0\d|1[0-3]):[0-5]\d$|^[+-]14:00$/.test(offset.trim()) ? offset.trim() : null;
  return { photoTakenAt: zone ? `${local} ${zone}` : local, photoTakenAtIso: zone ? new Date(`${local.replace(' ','T')}${zone}`).toISOString() : null };
}
function degrees(value: unknown, ref: unknown, positive: string, negative: string, max: number): number | null {
  if (!Array.isArray(value) || value.length!==3 || !value.every(x=>typeof x==='number' && Number.isFinite(x) && x>=0) || value[1]>=60 || value[2]>=60 || ![positive,negative].includes(String(ref))) return null;
  const result = value[0]+value[1]/60+value[2]/3600;
  return result<=max ? (ref===negative ? -result : result) : null;
}
export async function parsePhotoMetadata(bytes: ArrayBuffer | Uint8Array): Promise<PhotoMetadata> {
  try {
    // Raw date strings retain the original timezone information; no host timezone inference.
    const tags = await parse(bytes, { gps:true, exif:true, ifd0:false, reviveValues:false, translateValues:false, silentErrors:false,
      pick:['GPSLatitude','GPSLatitudeRef','GPSLongitude','GPSLongitudeRef','GPSMapDatum','GPSHPositioningError','DateTimeOriginal','OffsetTimeOriginal'] });
    if (!tags) return empty('missing');
    const time = photoTime(tags.DateTimeOriginal,tags.OffsetTimeOriginal);
    const hasGps = tags.GPSLatitude!==undefined || tags.GPSLongitude!==undefined;
    if (!hasGps) return { ...empty('missing'), ...time };
    const latitude = degrees(tags.GPSLatitude,tags.GPSLatitudeRef,'N','S',90), longitude = degrees(tags.GPSLongitude,tags.GPSLongitudeRef,'E','W',180);
    const datum = String(tags.GPSMapDatum || 'WGS84').replace(/[- _]/g,'').toUpperCase();
    if (latitude===null || longitude===null || datum!=='WGS84') return { ...empty('unreadable'), ...time };
    const accuracy = Number(tags.GPSHPositioningError);
    return { status:'ready', latitude, longitude, accuracy:Number.isFinite(accuracy) && accuracy>=0 && accuracy<=100000 ? accuracy : undefined, ...time };
  } catch (error) {
    return empty(/unknown file format|unsupported|not supported/i.test(String((error as Error)?.message)) ? 'unsupported' : 'unreadable');
  }
}
/** Metadata is read from the untouched selected original, never the resized OCR crop. */
export function readPhotoMetadata(filePath: string, timeoutMs = 6000): Promise<PhotoMetadata> {
  return new Promise((resolve) => {
    let finished=false;
    const done=(value:PhotoMetadata)=>{if(finished)return;finished=true;clearTimeout(timer);resolve(value);};
    const timer=setTimeout(()=>done(empty('unreadable')),timeoutMs);
    try {
      const files=wx.getFileSystemManager();
      files.stat({path:filePath,success:(result)=>{
        const stat=result.stats as WechatMiniprogram.Stats;
        if (!stat || !Number.isFinite(stat.size) || stat.size<=0 || stat.size>16*1024*1024) { done(empty('unreadable'));return; }
        files.readFile({filePath,success:(res)=>{
          if (typeof res.data==='string') {done(empty('unreadable'));return;}
          void parsePhotoMetadata(res.data).then(done,()=>done(empty('unreadable')));
        },fail:()=>done(empty('unreadable'))});
      },fail:()=>done(empty('unreadable'))});
    } catch {done(empty('unreadable'));}
  });
}
