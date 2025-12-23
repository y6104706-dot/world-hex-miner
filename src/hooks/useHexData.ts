import { useState, useCallback, useRef } from 'react'
import type { HexFeature, HexInfo, HexProperties } from '../types/hex'
import type { ZoneType } from '../utils/hexUtils'
import {
  getHexDisk,
  getHexesInPolygon,
  latLngToParentHex,
  getSymmetricHexesForParent,
  getSymmetricHexCoords,
  type SymmetricHexId,
  getParentHexFromSymmetricId,
  parseSymmetricHexId,
} from '../utils/hexUtils'
import { calculateOwnershipForHexes } from './useOwnership'
import type { OwnershipState } from './useOwnership'

const API_BASE = ''

interface UseHexDataOptions {
  ownership: OwnershipState
  selectedHex: string | null
  gpsHex: string | null
  authToken: string | null
}

/**
 * Process array in batches with a delay between batches
 */
async function processInBatches<T, R>(
  items: T[],
  batchSize: number,
  processor: (item: T) => Promise<R>,
  delayMs: number = 100,
  abortSignal?: AbortSignal
): Promise<R[]> {
  const results: R[] = []
  const totalBatches = Math.ceil(items.length / batchSize)
  console.log(`[processInBatches] Processing ${items.length} items in ${totalBatches} batches of ${batchSize}`)
  
  for (let i = 0; i < items.length; i += batchSize) {
    // Check if aborted
    if (abortSignal?.aborted) {
      console.log(`[processInBatches] Aborted at batch ${Math.floor(i / batchSize) + 1}`)
      throw new Error('Load aborted')
    }
    
    const batch = items.slice(i, i + batchSize)
    const batchNum = Math.floor(i / batchSize) + 1
    console.log(`[processInBatches] Processing batch ${batchNum}/${totalBatches} (${batch.length} items)`)
    
    try {
      const batchResults = await Promise.all(batch.map(processor))
      results.push(...batchResults)
      
      console.log(`[processInBatches] Completed batch ${batchNum}/${totalBatches}`)
    } catch (err) {
      if (err instanceof Error && err.message === 'Load aborted') {
        throw err
      }
      // Continue with other items even if one fails
      console.warn(`[processInBatches] Error in batch ${batchNum}:`, err)
    }
    
    // Add delay between batches to avoid overwhelming the server
    if (i + batchSize < items.length) {
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
  
  console.log(`[processInBatches] Completed all ${totalBatches} batches, total results: ${results.length}`)
  return results
}

/**
 * Hook for managing hex data - loading, caching, and ownership
 */
export function useHexData(options: UseHexDataOptions) {
  const { ownership, selectedHex, gpsHex } = options
  const [loading, setLoading] = useState(false)
  const hexInfoCacheRef = useRef<Map<string, HexInfo>>(new Map())
  const abortControllerRef = useRef<AbortController | null>(null)

  /**
   * Load hex info from API (zone type, etc.)
   * For symmetric hexes, checks the parent hex (H3 Res 7)
   */
  const loadHexInfo = useCallback(
    async (hexIndex: string): Promise<HexInfo> => {
      // Check if current load is aborted
      if (abortControllerRef.current?.signal.aborted) {
        throw new Error('Load aborted')
      }
      
      // If this is a symmetric hex ID, extract the parent hex
      const parentHex = getParentHexFromSymmetricId(hexIndex) || hexIndex
      
      // Check cache first (by parent hex)
      const cached = hexInfoCacheRef.current.get(parentHex)
      if (cached) {
        return cached
      }

      try {
        // Check parent hex with OSM (backend will handle symmetric hex IDs)
        const url = `${API_BASE}/api/hex/${parentHex}/osm`
        const res = await fetch(url, {
          signal: abortControllerRef.current?.signal,
        })
        if (res.ok) {
          const data: { zoneType?: ZoneType; debug?: string[] } = await res.json()
          const info: HexInfo = {
            h3Index: parentHex, // Store parent hex in cache
            zoneType: data.zoneType || 'URBAN',
            debugInfo: data.debug,
          }
          hexInfoCacheRef.current.set(parentHex, info)
          return info
        } else {
          console.warn(`[useHexData] Failed to load hex info for ${parentHex}:`, res.status, res.statusText)
        }
      } catch (err) {
        console.error(`[useHexData] Error loading hex info for ${hexIndex}:`, err)
      }

      // Fallback
      const fallback: HexInfo = {
        h3Index: hexIndex,
        zoneType: 'URBAN',
      }
      hexInfoCacheRef.current.set(hexIndex, fallback)
      return fallback
    },
    []
  )

  /**
   * Create hex features from parent hex indexes (H3 Res 7)
   * Each parent hex is divided into symmetric sub-hexes (49x49 grid)
   */
  const createHexFeatures = useCallback(
    async (
      parentHexIndexes: string[],
      options?: {
        loadInfo?: boolean
        markSelected?: boolean
        markGps?: boolean
      }
    ): Promise<HexFeature[]> => {
      const { loadInfo = true, markSelected = true, markGps = true } = options || {}

      console.log('[useHexData] createHexFeatures called:', { 
        parentHexCount: parentHexIndexes.length, 
        loadInfo,
        markSelected,
        markGps 
      })

      // Load zone type info for parent hexes (check parent hex with OSM)
      let parentHexInfos: HexInfo[]
      if (loadInfo) {
        console.log('[useHexData] Loading parent hex info in batches...')
        parentHexInfos = await processInBatches(
          parentHexIndexes, 
          5, 
          loadHexInfo, 
          200, 
          abortControllerRef.current?.signal
        ) // 5 at a time, 200ms delay
        console.log('[useHexData] Loaded', parentHexInfos.length, 'parent hex infos')
      } else {
        parentHexInfos = parentHexIndexes.map((idx) => {
          const cached = hexInfoCacheRef.current.get(idx)
          return (
            cached || {
              h3Index: idx,
              zoneType: 'URBAN' as ZoneType,
            }
          )
        })
      }

      // Create symmetric hexes for each parent hex
      const allSymmetricHexes: SymmetricHexId[] = []
      const parentHexToInfo = new Map<string, HexInfo>()
      
      for (let i = 0; i < parentHexIndexes.length; i++) {
        const parentHex = parentHexIndexes[i]
        const info = parentHexInfos[i]
        parentHexToInfo.set(parentHex, info)
        
        // Get all symmetric hexes for this parent
        const symmetricHexes = getSymmetricHexesForParent(parentHex)
        allSymmetricHexes.push(...symmetricHexes)
      }

      console.log('[useHexData] Created', allSymmetricHexes.length, 'symmetric hexes from', parentHexIndexes.length, 'parent hexes')

      // Calculate ownership for all symmetric hexes
      const ownershipMap = calculateOwnershipForHexes(allSymmetricHexes, ownership)

      // Create features for symmetric hexes
      console.log('[useHexData] Creating feature objects...')
      const features: HexFeature[] = allSymmetricHexes.map((symmetricHexId) => {
        const parsed = parseSymmetricHexId(symmetricHexId)
        if (!parsed) {
          throw new Error(`Invalid symmetric hex ID: ${symmetricHexId}`)
        }
        
        const { parentHex, row, col } = parsed
        const parentInfo = parentHexToInfo.get(parentHex) || {
          h3Index: parentHex,
          zoneType: 'URBAN' as ZoneType,
        }
        
        const ownershipData = ownershipMap.get(symmetricHexId) || {
          owner: null,
          isMine: false,
          isOthers: false,
        }
        const isOwned = ownership.ownedHexes.has(symmetricHexId)
        const canMine = !isOwned

        // Check if this hex should be selected
        const isSelected =
          (markSelected && selectedHex === symmetricHexId) || (markGps && gpsHex === symmetricHexId)

        // Get symmetric hex coordinates
        const coords = getSymmetricHexCoords(parentHex, row, col)

        // MapLibre requires all property values to be primitives (string, number, boolean)
        const properties: HexProperties = {
          h3Index: symmetricHexId, // Use symmetric hex ID
          zoneType: parentInfo.zoneType, // Use parent hex zone type
          claimed: isOwned,
          selected: isSelected || false,
          isGpsHex: false, // Not used for symmetric hexes
          canMine: canMine || false,
          owner: ownershipData.owner || null,
          isMine: ownershipData.isMine || false,
          isOthers: ownershipData.isOthers || false,
        }

        return {
          type: 'Feature',
          properties,
          geometry: {
            type: 'Polygon',
            coordinates: [coords],
          },
        }
      })

      console.log('[useHexData] Created', features.length, 'feature objects')
      return features
    },
    [ownership, selectedHex, gpsHex, loadHexInfo]
  )

  /**
   * Load hexes for current viewport
   * Strategy: Load hexes immediately without zone types, then enhance with zone types in background
   */
  const loadHexesForViewport = useCallback(
    async (
      center: { lat: number; lng: number },
      options?: {
        radius?: number
        useGps?: boolean
      }
    ): Promise<HexFeature[]> => {
      // Cancel any ongoing load
      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
      }
      
      // Create new abort controller
      const abortController = new AbortController()
      abortControllerRef.current = abortController
      
      setLoading(true)
      try {
        const { radius = 4, useGps = false } = options || {} // Radius 4 for good coverage

        // Get parent hexes (H3 Res 7) instead of Res 11
        let parentHexIndexes: string[]
        if (useGps && gpsHex) {
          // If gpsHex is a symmetric hex, get its parent
          const parentHex = getParentHexFromSymmetricId(gpsHex) || latLngToParentHex(center.lat, center.lng)
          parentHexIndexes = getHexDisk(parentHex, radius)
        } else {
          const centerParentHex = latLngToParentHex(center.lat, center.lng)
          parentHexIndexes = getHexDisk(centerParentHex, radius)
        }

        // Get viewport parent hexes with larger coverage
        // At zoom 14, 0.01 degrees ≈ 1 km - covers visible area for Res 7 hexes
        const deltaLat = 0.01
        const deltaLng = 0.01
        
        // H3 polygonToCells expects [lat, lng] format and counter-clockwise winding
        // Build polygon: south-west -> south-east -> north-east -> north-west -> south-west
        const polygon: number[][][] = [
          [
            [center.lat - deltaLat, center.lng - deltaLng], // SW
            [center.lat - deltaLat, center.lng + deltaLng], // SE
            [center.lat + deltaLat, center.lng + deltaLng], // NE
            [center.lat + deltaLat, center.lng - deltaLng], // NW
            [center.lat - deltaLat, center.lng - deltaLng], // Close: SW
          ],
        ]
        const viewportParentHexes = getHexesInPolygon(polygon)
        parentHexIndexes = [...new Set([...parentHexIndexes, ...viewportParentHexes])]
        
        // No limit - show all hexes in viewport

        // Create symmetric hex features from parent hexes WITHOUT loading zone types first - instant display
        const features = await createHexFeatures(parentHexIndexes, {
          loadInfo: false, // Don't load zone types initially
          markSelected: true,
          markGps: true,
        })
        
        // Check if this load was aborted
        if (abortController.signal.aborted) {
          throw new Error('Load aborted')
        }
        
        return features
      } catch (err) {
        if (err instanceof Error && err.message === 'Load aborted') {
          throw err
        }
        console.error('[useHexData] Error in loadHexesForViewport:', err)
        // Return empty array on error instead of throwing
        return []
      } finally {
        if (abortControllerRef.current === abortController) {
          setLoading(false)
        }
      }
    },
    [gpsHex, createHexFeatures]
  )

  return {
    loading,
    loadHexInfo,
    createHexFeatures,
    loadHexesForViewport,
    hexInfoCache: hexInfoCacheRef.current,
  }
}

