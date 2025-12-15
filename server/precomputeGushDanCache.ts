import * as h3 from 'h3-js'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { inferZoneTypeFromOverpass } from './index'

// Simple standalone script to precompute hexCache.json for the Gush Dan area.
// It uses the same inferZoneTypeFromOverpass logic as the server and writes
// the resulting map of h3Index -> { zoneType, debug } to data/hexCache.json.

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const dataDir = path.join(__dirname, '..', 'data')
const hexCachePath = path.join(dataDir, 'hexCache.json')

// Very small pilot bounding box around Tel Aviv beach (sea + coast + urban + roads).
// This area should contain a mix of SEA, COAST, MAIN_ROAD and URBAN hexes so we
// can validate the classification behaviour at the same resolution used by the
// app (11) without overloading Overpass.
// Approx area: around Tel Aviv coastline near 32.08N, 34.77E.
const south = 32.06
const north = 32.10
const west = 34.75
const east = 34.79

// Use the same resolution as the frontend map for accurate per-hex testing.
const h3Resolution = 11

async function main() {
  console.log('Precomputing hexCache pilot for Tel Aviv beach area (res 11)...')

  // Build a rectangle polygon
  const polygon: number[][][] = [[
    [south, west],
    [south, east],
    [north, east],
    [north, west],
    [south, west],
  ]]

  const hexIndexes = h3.polygonToCells(polygon, h3Resolution, true)
  console.log(`Total hexes in small pilot area at res ${h3Resolution}:`, hexIndexes.length)

  // For the initial pilot, only process the first few hundred hexes so that
  // the script completes in reasonable time and does not hammer Overpass.
  const maxHexes = 600
  const limitedHexIndexes = hexIndexes.slice(0, maxHexes)
  console.log(`Limiting processing to first ${limitedHexIndexes.length} hexes`)

  const cache: Record<string, { zoneType: string; debug: string[] }> = {}

  let processed = 0
  for (const h3Index of limitedHexIndexes) {
    processed += 1
    try {
      const inferred = await inferZoneTypeFromOverpass(h3Index)
      cache[h3Index] = {
        zoneType: inferred.zoneType,
        debug: inferred.debug,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('Failed to infer zone for', h3Index, message)
    }

    if (processed % 50 === 0) {
      console.log(`Processed ${processed}/${hexIndexes.length} hexes...`)
    }
  }

  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true })
  }

  fs.writeFileSync(hexCachePath, JSON.stringify(cache, null, 2), 'utf8')
  console.log('Written cache to', hexCachePath)
}

main().catch((err) => {
  console.error('Fatal error in precomputeGushDanCache:', err)
  process.exit(1)
})
