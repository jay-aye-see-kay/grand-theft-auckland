// Coordinate frames for the city generator.
//
//   WGS84 lon/lat (OSM)  ->  NZTM2000 easting/northing (EPSG:2193, LINZ rasters)
//                        ->  local game metres
//
// Local frame: origin at Britomart, x = east, z = south (north is -z, as in the
// game's test town), y = metres above sea level (NZVD2016, the LiDAR datum), so
// y is NOT shifted by the origin. Local axes are aligned with the NZTM grid,
// not true north: grid convergence in the CBD is well under 1 degree, and
// staying on the grid keeps raster rows/columns axis-aligned in game space.
import proj4 from 'proj4';

export const NZTM = 'EPSG:2193';
proj4.defs(
  NZTM,
  '+proj=tmerc +lat_0=0 +lon_0=173 +k=0.9996 +x_0=1600000 +y_0=10000000 ' +
    '+ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs',
);
const toNztm = proj4('EPSG:4326', NZTM);

export type LonLat = { lon: number; lat: number };
/** NZTM2000 easting / northing in metres. */
export type Nztm = { e: number; n: number };
/** Local game metres on the ground plane (y is handled separately). */
export type Local = { x: number; z: number };
/** [minLon, minLat, maxLon, maxLat], the OSM API's bbox order. */
export type BBox = [number, number, number, number];

/** The CBD area for tier 1. */
export const CBD_BBOX: BBox = [174.752, -36.861, 174.776, -36.839];

/** Britomart: the local origin. */
export const ORIGIN: LonLat = { lon: 174.768, lat: -36.8443 };

export function lonLatToNztm(lon: number, lat: number): Nztm {
  const [e, n] = toNztm.forward([lon, lat]);
  return { e, n };
}

export function nztmToLonLat(e: number, n: number): LonLat {
  const [lon, lat] = toNztm.inverse([e, n]);
  return { lon, lat };
}

/** NZTM coordinates of the local origin. */
export const ORIGIN_NZTM: Nztm = lonLatToNztm(ORIGIN.lon, ORIGIN.lat);

export function nztmToLocal(e: number, n: number): Local {
  return { x: e - ORIGIN_NZTM.e, z: -(n - ORIGIN_NZTM.n) };
}

export function localToNztm(x: number, z: number): Nztm {
  return { e: x + ORIGIN_NZTM.e, n: ORIGIN_NZTM.n - z };
}

export function lonLatToLocal(lon: number, lat: number): Local {
  const p = lonLatToNztm(lon, lat);
  return nztmToLocal(p.e, p.n);
}

export function localToLonLat(x: number, z: number): LonLat {
  const p = localToNztm(x, z);
  return nztmToLonLat(p.e, p.n);
}

/** Axis-aligned NZTM extent covering a WGS84 bbox (all four corners), padded. */
export function bboxToNztmExtent(bbox: BBox, padMetres = 0) {
  const [w, s, e, n] = bbox;
  const corners = [lonLatToNztm(w, s), lonLatToNztm(w, n), lonLatToNztm(e, s), lonLatToNztm(e, n)];
  return {
    minE: Math.min(...corners.map((c) => c.e)) - padMetres,
    minN: Math.min(...corners.map((c) => c.n)) - padMetres,
    maxE: Math.max(...corners.map((c) => c.e)) + padMetres,
    maxN: Math.max(...corners.map((c) => c.n)) + padMetres,
  };
}
