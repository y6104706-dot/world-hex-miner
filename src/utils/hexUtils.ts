import * as h3 from 'h3-js'

export type ZoneType =
  | 'SEA'
  | 'MAIN_ROAD'
  | 'URBAN'
  | 'INTERURBAN'
  | 'MILITARY'
  | 'HOSPITAL'
  | 'CLIFF'
  | 'NATURE_RESERVE'
  | 'PRISON'

// H3 Resolution for parent hexes (large hexes that contain symmetric sub-hexes)
export const H3_PARENT_RESOLUTION = 7
// Grid size for dividing parent hex into symmetric sub-hexes (49x49 = 2,401 hexes)
export const SYMMETRIC_GRID_SIZE = 49

/**
 * Convert H3 hex boundary to MapLibre coordinates
 * H3 returns [lat, lng], MapLibre expects [lng, lat]
 */
export function hexToMapLibreCoords(hexIndex: string): [number, number][] {
  const boundary = h3.cellToBoundary(hexIndex, true) // Returns [lat, lng][]
  // Convert to [lng, lat] for MapLibre
  return boundary.map(([lat, lng]) => [lng, lat] as [number, number])
}

/**
 * Get parent H3 hex (Res 7) from lat/lng coordinates
 */
export function latLngToParentHex(lat: number, lng: number): string {
  return h3.latLngToCell(lat, lng, H3_PARENT_RESOLUTION)
}

/**
 * Get H3 hex index from lat/lng coordinates (legacy - now uses parent hex)
 * @deprecated Use latLngToParentHex instead
 */
export function latLngToHex(lat: number, lng: number): string {
  return latLngToParentHex(lat, lng)
}

/**
 * Get lat/lng from H3 hex index (geodesic center)
 */
export function hexToLatLng(hexIndex: string): { lat: number; lng: number } {
  const [lat, lng] = h3.cellToLatLng(hexIndex)
  return { lat, lng }
}

/**
 * Calculate visual centroid from polygon coordinates (for map display)
 * This ensures points are centered on the distorted hexes on the map
 */
export function calculatePolygonCentroid(coords: [number, number][]): [number, number] {
  let sumLng = 0
  let sumLat = 0
  let count = 0

  // Sum all coordinates (excluding the last duplicate point if present)
  const endIndex = coords.length > 0 && 
    coords[0][0] === coords[coords.length - 1][0] && 
    coords[0][1] === coords[coords.length - 1][1]
    ? coords.length - 1
    : coords.length

  for (let i = 0; i < endIndex; i++) {
    const [lng, lat] = coords[i]
    sumLng += lng
    sumLat += lat
    count++
  }

  return [sumLng / count, sumLat / count]
}

/**
 * Get all hexes in a disk around a center hex
 */
export function getHexDisk(centerHex: string, radius: number): string[] {
  return h3.gridDisk(centerHex, radius)
}

/**
 * Get parent hexes in a polygon (for viewport loading)
 */
export function getHexesInPolygon(polygon: number[][][]): string[] {
  return h3.polygonToCells(polygon, H3_PARENT_RESOLUTION, true)
}

/**
 * Check if two hexes are neighbors
 */
export function areNeighbors(hex1: string, hex2: string): boolean {
  const neighbors = h3.gridDisk(hex1, 1)
  return neighbors.includes(hex2)
}

/**
 * Symmetric hex ID format: "parentHexId:row:col"
 * Example: "8b2db0cc1710fff:25:30"
 */
export type SymmetricHexId = string

/**
 * Parse symmetric hex ID into components
 */
export function parseSymmetricHexId(hexId: SymmetricHexId): {
  parentHex: string
  row: number
  col: number
} | null {
  const parts = hexId.split(':')
  if (parts.length !== 3) return null
  const [parentHex, rowStr, colStr] = parts
  const row = parseInt(rowStr, 10)
  const col = parseInt(colStr, 10)
  if (isNaN(row) || isNaN(col)) return null
  return { parentHex, row, col }
}

/**
 * Create symmetric hex ID from parent hex and grid coordinates
 */
export function createSymmetricHexId(parentHex: string, row: number, col: number): SymmetricHexId {
  return `${parentHex}:${row}:${col}`
}

/**
 * Get parent H3 hex from symmetric hex ID
 */
export function getParentHexFromSymmetricId(hexId: SymmetricHexId): string | null {
  const parsed = parseSymmetricHexId(hexId)
  return parsed?.parentHex || null
}

/**
 * Get symmetric hex coordinates (polygon) from parent hex and grid position
 * Returns coordinates in [lng, lat] format for MapLibre
 * Creates a proper hexagonal grid with offset rows
 */
export function getSymmetricHexCoords(
  parentHex: string,
  row: number,
  col: number,
  gridSize: number = SYMMETRIC_GRID_SIZE
): [number, number][] {
  // Get parent hex boundary
  const parentBoundary = h3.cellToBoundary(parentHex, true) // [lat, lng][]
  
  // Calculate bounding box of parent hex
  const lats = parentBoundary.map(([lat]) => lat)
  const lngs = parentBoundary.map(([, lng]) => lng)
  const minLat = Math.min(...lats)
  const maxLat = Math.max(...lats)
  const minLng = Math.min(...lngs)
  const maxLng = Math.max(...lngs)
  
  // Calculate cell size in the grid
  const latRange = maxLat - minLat
  const lngRange = maxLng - minLng
  
  // Hexagonal grid: each hex has a radius (distance from center to vertex)
  // For a proper hex grid, we need to account for the hexagonal shape
  // Hex width (flat-to-flat) = sqrt(3) * radius
  // Hex height (point-to-point) = 2 * radius
  
  // Calculate approximate hex radius based on grid size
  // We want to cover the entire parent hex with the grid
  const hexRadius = Math.min(latRange, lngRange) / (gridSize * 1.5) // Approximate
  
  // Hex width (flat-to-flat distance)
  const hexWidth = Math.sqrt(3) * hexRadius
  const hexHeight = 2 * hexRadius
  
  // Calculate hex center with proper hexagonal grid offset
  // Odd rows are offset by half a hex width
  const rowOffset = row % 2 === 0 ? 0 : hexWidth / 2
  const centerLat = minLat + (row + 0.5) * hexHeight * 0.75 // 0.75 accounts for hex overlap
  const centerLng = minLng + (col + 0.5) * hexWidth + rowOffset
  
  // Generate 6 vertices of hexagon (pointy-top orientation)
  // Start from top vertex and go clockwise
  const vertices: [number, number][] = []
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 3) * i - Math.PI / 2 // Start at top (90 degrees)
    // Convert radius to lat/lng degrees (approximate)
    const latOffset = hexRadius * Math.cos(angle) / 111 // 1 degree lat ≈ 111 km
    const lngOffset = hexRadius * Math.sin(angle) / (111 * Math.cos(centerLat * Math.PI / 180))
    const lat = centerLat + latOffset
    const lng = centerLng + lngOffset
    vertices.push([lng, lat]) // [lng, lat] for MapLibre
  }
  
  // Close the polygon
  vertices.push(vertices[0])
  
  return vertices
}

/**
 * Get all symmetric hexes for a parent hex
 */
export function getSymmetricHexesForParent(
  parentHex: string,
  gridSize: number = SYMMETRIC_GRID_SIZE
): SymmetricHexId[] {
  const hexes: SymmetricHexId[] = []
  for (let row = 0; row < gridSize; row++) {
    for (let col = 0; col < gridSize; col++) {
      hexes.push(createSymmetricHexId(parentHex, row, col))
    }
  }
  return hexes
}

/**
 * Get symmetric hex ID from lat/lng coordinates
 */
export function latLngToSymmetricHex(lat: number, lng: number): SymmetricHexId {
  const parentHex = latLngToParentHex(lat, lng)
  
  // Get parent hex boundary to calculate grid position
  const parentBoundary = h3.cellToBoundary(parentHex, true)
  const lats = parentBoundary.map(([lat]) => lat)
  const lngs = parentBoundary.map(([, lng]) => lng)
  const minLat = Math.min(...lats)
  const maxLat = Math.max(...lats)
  const minLng = Math.min(...lngs)
  const maxLng = Math.max(...lngs)
  
  const latRange = maxLat - minLat
  const lngRange = maxLng - minLng
  const cellLatSize = latRange / SYMMETRIC_GRID_SIZE
  const cellLngSize = lngRange / SYMMETRIC_GRID_SIZE
  
  // Calculate grid position
  const row = Math.floor((lat - minLat) / cellLatSize)
  const col = Math.floor((lng - minLng) / cellLngSize)
  
  // Clamp to grid bounds
  const clampedRow = Math.max(0, Math.min(SYMMETRIC_GRID_SIZE - 1, row))
  const clampedCol = Math.max(0, Math.min(SYMMETRIC_GRID_SIZE - 1, col))
  
  return createSymmetricHexId(parentHex, clampedRow, clampedCol)
}

