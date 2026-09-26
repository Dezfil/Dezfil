/**
 * Limits shared by every Dezfil map camera.
 *
 * This is a camera ceiling, not a tile-source promise. Vector and raster
 * sources retain their own maxZoom values; MapLibre may overzoom those
 * sources while Dezfil overlays and camera state continue through the
 * published image-definition range.
 */
export const MAP_MAX_ZOOM = 24;
export const MAP_MIN_ZOOM = -2;
export const IMAGE_MIN_ZOOM = 0;
export const MAP_MIN_PITCH = 0;
export const MAP_MAX_PITCH = 60;
export const MAP_MAX_LATITUDE = 85.051129;
export const MAP_MIN_LATITUDE = -MAP_MAX_LATITUDE;

/** JSON-schema bounds are shared with the image validator and OpenAPI. */
export const CAMERA_BOUNDS = {
  pitch: { minimum: MAP_MIN_PITCH, maximum: MAP_MAX_PITCH },
  lat: { minimum: MAP_MIN_LATITUDE, maximum: MAP_MAX_LATITUDE },
  zoom: { minimum: MAP_MIN_ZOOM, maximum: MAP_MAX_ZOOM },
} as const;
