import { useState, useEffect, useCallback } from 'react'
import type { HexFeature } from '../types/hex'
import { hexToMapLibreCoords } from '../utils/hexUtils'
import type { OwnershipState } from './useOwnership'

const API_BASE = ''

interface UseVeinsLayerOptions {
  ownership: OwnershipState
  authToken: string | null
}

/**
 * Hook to load all globally owned hexes and create features for the "veins" layer
 * This layer shows all mined hexes everywhere on the map
 */
export function useVeinsLayer({ ownership, authToken }: UseVeinsLayerOptions) {
  const [veinsFeatures, setVeinsFeatures] = useState<HexFeature[]>([])
  const [loading, setLoading] = useState(false)

  /**
   * Create hex features from hex indexes for veins layer
   */
  const createVeinsFeatures = useCallback(
    (mineHexes: string[], othersHexes: string[]): HexFeature[] => {
      const features: HexFeature[] = []
      
      // Create features for mine hexes
      mineHexes.forEach((hexIndex) => {
        const coords = hexToMapLibreCoords(hexIndex)
        coords.push(coords[0]) // Close polygon
        
        features.push({
          type: 'Feature',
          properties: {
            h3Index: hexIndex,
            zoneType: 'URBAN',
            claimed: true,
            selected: false,
            canMine: false,
            owner: 'mine',
            isMine: true,
            isOthers: false,
          },
          geometry: {
            type: 'Polygon',
            coordinates: [coords],
          },
        })
      })
      
      // Create features for others hexes
      othersHexes.forEach((hexIndex) => {
        const coords = hexToMapLibreCoords(hexIndex)
        coords.push(coords[0]) // Close polygon
        
        features.push({
          type: 'Feature',
          properties: {
            h3Index: hexIndex,
            zoneType: 'URBAN',
            claimed: true,
            selected: false,
            canMine: false,
            owner: 'others',
            isMine: false,
            isOthers: true,
          },
          geometry: {
            type: 'Polygon',
            coordinates: [coords],
          },
        })
      })
      
      return features
    },
    []
  )

  /**
   * Load all owned hexes and create veins features
   */
  useEffect(() => {
    if (!authToken) {
      setVeinsFeatures([])
      return
    }

    const loadVeins = async () => {
      setLoading(true)
      try {
        const headers: HeadersInit = {
          Authorization: `Bearer ${authToken}`,
        }
        const res = await fetch(`${API_BASE}/api/owned-hexes/global`, { headers })
        
        if (res.ok) {
          const data: { mine?: string[]; others?: string[] } = await res.json().catch(() => ({}))
          const mine = Array.isArray(data.mine) ? data.mine : []
          const others = Array.isArray(data.others) ? data.others : []
          const allOwned = [...mine, ...others]

          console.log(`[useVeinsLayer] Loading ${allOwned.length} owned hexes (${mine.length} mine, ${others.length} others)`)
          console.log(`[useVeinsLayer] Mine hexes:`, mine.slice(0, 5))
          
          const features = createVeinsFeatures(mine, others)
          const mineFeatures = features.filter(f => f.properties.isMine).length
          const othersFeatures = features.filter(f => f.properties.isOthers).length
          setVeinsFeatures(features)
          console.log(`[useVeinsLayer] Created ${features.length} veins features (${mineFeatures} mine, ${othersFeatures} others)`)
        }
      } catch (err) {
        console.error('[useVeinsLayer] Failed to load veins:', err)
      } finally {
        setLoading(false)
      }
    }

    void loadVeins()
  }, [authToken, createVeinsFeatures, ownership.ownedHexes.size, ownership.globalOwnedHexes.size]) // Re-run when ownership changes

  // Update veins when ownership changes (e.g., after mining)
  useEffect(() => {
    setVeinsFeatures((prev) => {
      if (prev.length === 0) return prev
      
      // Update existing features with new ownership data
      return prev.map((f) => {
        const hexIndex = f.properties.h3Index
        const isMine = ownership.ownedHexes.has(hexIndex)
        const isOthers = !isMine && ownership.globalOwnedHexes.has(hexIndex)

        return {
          ...f,
          properties: {
            ...f.properties,
            isMine,
            isOthers,
            owner: isMine ? ('mine' as const) : isOthers ? ('others' as const) : null,
          },
        }
      })
    })
  }, [ownership])

  return { veinsFeatures, loading }
}

