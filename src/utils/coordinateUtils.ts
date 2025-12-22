/**
 * Coordinate utilities for consistent handling of [lng, lat] vs [lat, lng]
 * MapLibre uses [lng, lat] format
 * H3 uses [lat, lng] format
 */

/**
 * Validate coordinates are within reasonable bounds for Israel
 * Israel is roughly: lat 29-34°N, lng 34-36°E
 */
export function isValidIsraelCoords(lat: number, lng: number): boolean {
  return lat >= 29 && lat <= 34 && lng >= 34 && lng <= 36
}

/**
 * Validate bounds for fitBounds
 */
export function isValidBounds(
  minLng: number,
  maxLng: number,
  minLat: number,
  maxLat: number
): boolean {
  return (
    minLng >= 30 &&
    maxLng <= 36 &&
    minLat >= 29 &&
    maxLat <= 34 &&
    minLng < maxLng &&
    minLat < maxLat
  )
}

/**
 * Convert [lat, lng] to [lng, lat] for MapLibre
 */
export function toMapLibreCoords(coords: [number, number]): [number, number] {
  return [coords[1], coords[0]]
}

/**
 * Convert [lng, lat] to [lat, lng] for H3
 */
export function toH3Coords(coords: [number, number]): [number, number] {
  return [coords[1], coords[0]]
}






