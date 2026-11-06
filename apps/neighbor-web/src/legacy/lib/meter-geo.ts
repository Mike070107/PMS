import { gcj02ToWgs84 } from '@pms/shared-types';
export { wgs84ToGcj02, gcj02ToWgs84 } from '@pms/shared-types';

export function readingMapUrl(longitude: number, latitude: number): string | null {
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude) || Math.abs(longitude) > 180 || Math.abs(latitude) > 90) return null;
  const [lng, lat] = gcj02ToWgs84(longitude, latitude);
  const params = new URLSearchParams({ bbox: [Math.max(-180,lng-.003),Math.max(-90,lat-.002),Math.min(180,lng+.003),Math.min(90,lat+.002)].join(','), layer: 'mapnik', marker: `${lat},${lng}` });
  return `https://www.openstreetmap.org/export/embed.html?${params}`;
}
