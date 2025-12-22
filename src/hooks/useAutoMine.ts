import { useRef, useCallback } from 'react'
import * as h3 from 'h3-js'

const API_BASE = ''

interface UseAutoMineOptions {
  enabled: boolean
  authToken: string | null
  gpsCoords: { lat: number; lon: number; accuracyM: number } | null
  onMineSuccess?: (hexIndex: string) => void
  onMineError?: (error: string) => void
}

/**
 * Hook for auto-mining functionality
 * Automatically mines hexes when GPS location changes
 */
export function useAutoMine(options: UseAutoMineOptions) {
  const { enabled, authToken, gpsCoords, onMineSuccess, onMineError } = options
  const lastMinedHexRef = useRef<string | null>(null)
  const isMiningRef = useRef(false)

  const authedFetch = useCallback(
    (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      if (authToken) {
        headers.set('Authorization', `Bearer ${authToken}`)
      }
      return fetch(input, { ...init, headers })
    },
    [authToken]
  )

  const mineHex = useCallback(
    async (hexIndex: string): Promise<boolean> => {
      if (!authToken || !gpsCoords || isMiningRef.current) {
        return false
      }

      // Don't mine the same hex twice
      if (lastMinedHexRef.current === hexIndex) {
        return false
      }

      isMiningRef.current = true

      try {
        const res = await authedFetch(`${API_BASE}/api/mine`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            h3Index: hexIndex,
            lat: gpsCoords.lat,
            lon: gpsCoords.lon,
            accuracyM: gpsCoords.accuracyM || 10,
            gpsAt: Date.now(),
          }),
        })

        const data: { ok?: boolean; newBalance?: number; error?: string } =
          await res.json().catch(() => ({}))

        if (data.ok) {
          lastMinedHexRef.current = hexIndex
          onMineSuccess?.(hexIndex)
          return true
        } else {
          onMineError?.(data.error || 'Mining failed')
          return false
        }
      } catch (err) {
        onMineError?.(err instanceof Error ? err.message : 'Network error')
        return false
      } finally {
        isMiningRef.current = false
      }
    },
    [authToken, gpsCoords, authedFetch, onMineSuccess, onMineError]
  )

  const checkAndMine = useCallback(() => {
    if (!enabled || !authToken || !gpsCoords) {
      return
    }

    try {
      // Use H3 resolution 11 (same as the main app)
      const currentHex = h3.latLngToCell(gpsCoords.lat, gpsCoords.lon, 11)

      // Don't mine if already mined
      if (lastMinedHexRef.current === currentHex) {
        return
      }

      // Mine the hex
      void mineHex(currentHex)
    } catch (err) {
      console.error('[useAutoMine] Error checking hex:', err)
    }
  }, [enabled, authToken, gpsCoords, mineHex])

  return {
    mineHex,
    checkAndMine,
    lastMinedHex: lastMinedHexRef.current,
  }
}

