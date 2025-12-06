import { useEffect, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import * as h3 from 'h3-js'
import 'maplibre-gl/dist/maplibre-gl.css'
import './App.css'

function App() {
  const apiBase =
    import.meta.env.VITE_API_BASE_URL ?? `${window.location.protocol}//${window.location.hostname}:4000`
  const mapContainerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)

  type ZoneType =
    | 'SEA'
    | 'MAIN_ROAD'
    | 'URBAN'
    | 'MILITARY'
    | 'HOSPITAL'
    | 'CLIFF'
    | 'COAST'
    | 'NATURE_RESERVE'
    | 'RIVER'

  type MiningRule = {
    minSpeedKmh: number | null
    description: string
  }

  const miningRules: Record<ZoneType, MiningRule> = {
    URBAN: {
      minSpeedKmh: null,
      description: 'Urban area – mining allowed while standing, walking or driving normally.',
    },
    MAIN_ROAD: {
      minSpeedKmh: 300,
      description: 'Main road – mining allowed only above 300 km/h (e.g. flying over the road).',
    },
    SEA: {
      minSpeedKmh: 7,
      description: 'Sea – mining allowed only above 7 km/h (moving on a boat).',
    },
    NATURE_RESERVE: {
      minSpeedKmh: 7,
      description: 'Nature reserve / forest – mining allowed only in a safe, controlled way (similar to sea, e.g. slow movement such as a guided tour or boat).',
    },
    RIVER: {
      minSpeedKmh: 7,
      description: 'River / stream – mining allowed only while moving along the water at low speed (e.g. boat or kayak).',
    },
    MILITARY: {
      minSpeedKmh: null,
      description: 'Military zone – mining is forbidden for safety and legal reasons.',
    },
    HOSPITAL: {
      minSpeedKmh: null,
      description: 'Hospital area – mining is forbidden to avoid encouraging risky behavior near hospitals.',
    },
    CLIFF: {
      minSpeedKmh: null,
      description: 'Cliff / dangerous terrain – mining is forbidden for safety reasons.',
    },
    COAST: {
      minSpeedKmh: null,
      description: 'Coastline – mining allowed at walking speed or above, but not in the water.',
    },
  }

  type HexFeature = {
    type: 'Feature'
    properties: {
      h3Index: string
      zoneType: ZoneType
      claimed: boolean
      selected: boolean
      debugInfo: string[]
    }
    geometry: {
      type: 'Polygon'
      coordinates: number[][][]
    }
  }

  const [selectedInfo, setSelectedInfo] = useState<string | null>(null)
  const [selectedDebug, setSelectedDebug] = useState<string[] | null>(null)
  const [selectedHex, setSelectedHex] = useState<{ h3Index: string; zoneType: ZoneType } | null>(null)
  const [mineMessage, setMineMessage] = useState<string | null>(null)
  const [mineMessageType, setMineMessageType] = useState<'success' | 'error' | null>(null)
  const [selectedOwned, setSelectedOwned] = useState<boolean | null>(null)
  const [userBalance, setUserBalance] = useState<number | null>(null)
  const [ownedCount, setOwnedCount] = useState<number | null>(null)
  const [toastMessage, setToastMessage] = useState<string | null>(null)
  const [toastType, setToastType] = useState<'success' | 'error' | null>(null)
  const featuresRef = useRef<HexFeature[]>([])
  const ownedHexesRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    if (!mapContainerRef.current) return

    const centerLonLat: [number, number] = [34.7818, 32.0853]
    const h3Resolution = 11

    const mapStyleUrl = import.meta.env.VITE_MAP_STYLE_URL ?? 'https://demotiles.maplibre.org/style.json'

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: mapStyleUrl,
      center: centerLonLat,
      zoom: 14,
    })

    mapRef.current = map

    map.on('load', () => {
      let features: HexFeature[] = []
      let hasFitToHexes = false

      // Create an empty GeoJSON source immediately so layers can safely reference it.
      const initialCollection = {
        type: 'FeatureCollection' as const,
        features,
      }

      map.addSource('h3-hex', {
        type: 'geojson',
        data: initialCollection,
      })

      const loadOwnedHexes = async () => {
        try {
          const res = await fetch(`${apiBase}/api/owned-hexes`)
          if (res.ok) {
            const data: { hexes?: string[] } = await res.json()
            if (Array.isArray(data.hexes)) {
              ownedHexesRef.current = new Set(data.hexes)
            }
          }
        } catch {
          // ignore load errors for now
        }
      }

      const loadHexesForCurrentView = async () => {
        const zoom = map.getZoom()

        // When zoomed out too far, do not render any hexes to keep performance
        // reasonable. Just clear the source and return.
        if (zoom < 14) {
          features = []
          featuresRef.current = []
          const emptyCollection = {
            type: 'FeatureCollection' as const,
            features: [] as HexFeature[],
          }
          const existing = map.getSource('h3-hex') as maplibregl.GeoJSONSource | undefined
          if (existing) {
            existing.setData(emptyCollection)
          }
          return
        }

        // Always refresh owned hexes from the backend before rebuilding features,
        // so that claimed state is correct after reload or viewport changes.
        await loadOwnedHexes()

        const bounds = map.getBounds()
        const south = bounds.getSouth()
        const north = bounds.getNorth()
        const west = bounds.getWest()
        const east = bounds.getEast()

        // h3-js expects coordinates in [lat, lng] order, while map bounds give
        // us lng (west/east) and lat (south/north). Build the polygon in
        // [lat, lng] format for polygonToCells.
        const polygon: number[][][] = [[
          [south, west],
          [south, east],
          [north, east],
          [north, west],
          [south, west],
        ]]

        const hexIndexes = h3.polygonToCells(polygon, h3Resolution, true)

        const ownedSet = ownedHexesRef.current

        const newFeatures: HexFeature[] = []

        for (const hexIndex of hexIndexes) {
          const boundary = h3.cellToBoundary(hexIndex, true)
          const coords = boundary.map(([lat, lng]) => [lng, lat])
          coords.push(coords[0])

          let zoneType: ZoneType = 'URBAN'
          let debugInfo: string[] = []
          try {
            const res = await fetch(`${apiBase}/api/hex/${hexIndex}`)
            if (res.ok) {
              const data: { zoneType?: ZoneType; debug?: string[] } = await res.json()
              if (data.zoneType) {
                zoneType = data.zoneType
              }
              if (Array.isArray(data.debug)) {
                debugInfo = data.debug
              }
            }
          } catch {
            // fallback to default URBAN if backend call fails
          }

          const isOwned = ownedSet.has(hexIndex)

          newFeatures.push({
            type: 'Feature',
            properties: {
              h3Index: hexIndex,
              zoneType,
              claimed: isOwned,
              selected: false,
              debugInfo,
            },
            geometry: {
              type: 'Polygon',
              coordinates: [coords],
            },
          })
        }

        features = newFeatures
        featuresRef.current = newFeatures

        const featureCollection = {
          type: 'FeatureCollection' as const,
          features,
        }

        const existing = map.getSource('h3-hex') as maplibregl.GeoJSONSource | undefined
        if (existing) {
          existing.setData(featureCollection)
        }

        if (!hasFitToHexes && features.length > 0) {
          const allCoords = features.flatMap((f) => f.geometry.coordinates[0] as [number, number][])
          const lngs = allCoords.map(([lng]) => lng)
          const lats = allCoords.map(([, lat]) => lat)
          const minLng = Math.min(...lngs)
          const maxLng = Math.max(...lngs)
          const minLat = Math.min(...lats)
          const maxLat = Math.max(...lats)

          map.fitBounds(
            [
              [minLng, minLat],
              [maxLng, maxLat],
            ],
            { padding: 40 },
          )

          hasFitToHexes = true
        }
      }

      void loadHexesForCurrentView()

      map.on('moveend', () => {
        void loadHexesForCurrentView()
      })

      map.addLayer({
        id: 'h3-hex-fill',
        type: 'fill',
        source: 'h3-hex',
        paint: {
          'fill-color': [
            'case',
            ['get', 'claimed'],
            '#1f6b40',
            ['get', 'selected'],
            '#ff9900',
            '#e0e0e0',
          ],
          'fill-opacity': [
            'case',
            ['get', 'claimed'],
            0.65,
            0.2,
          ],
        },
      })

      map.addLayer({
        id: 'h3-hex-outline',
        type: 'line',
        source: 'h3-hex',
        paint: {
          'line-color': '#555555',
          'line-width': 0.8,
          'line-opacity': 0.7,
        },
      })

      map.on('click', 'h3-hex-fill', async (event) => {
        const feature = event.features?.[0] as maplibregl.MapGeoJSONFeature | undefined
        if (!feature) return

        const h3Index = feature.properties?.h3Index as string | undefined
        let zoneType = feature.properties?.zoneType as ZoneType | undefined
        let rawDebug = feature.properties?.debugInfo as unknown

        if (!h3Index || !zoneType) return

        // On click, try to refine the zoneType using OSM/Overpass for this
        // specific hex only, to avoid rate limiting.
        try {
          const res = await fetch(`${apiBase}/api/hex/${h3Index}/osm`)
          if (res.ok) {
            const data: { zoneType?: ZoneType; debug?: string[] } = await res.json()
            if (data.zoneType) {
              zoneType = data.zoneType
            }
            if (Array.isArray(data.debug)) {
              rawDebug = data.debug
            }
          }
        } catch {
          // If OSM call fails, we keep the existing zoneType/debug from the
          // initial fallback response.
        }

        const debugInfo = Array.isArray(rawDebug)
          ? (rawDebug as string[])
          : rawDebug != null
            ? [String(rawDebug)]
            : null

        const rule = miningRules[zoneType]

        const speedText =
          rule.minSpeedKmh === null
            ? 'No special speed requirement.'
            : `Required minimum speed: ${rule.minSpeedKmh} km/h.`

        setSelectedInfo(
          `Hex: ${h3Index}\nZone type: ${zoneType}\n${rule.description}\n${speedText}`,
        )

        setSelectedDebug(debugInfo)
        setSelectedHex({ h3Index, zoneType })
        setMineMessage(null)
        setMineMessageType(null)

        const ownedSet = ownedHexesRef.current
        setSelectedOwned(ownedSet.has(h3Index))

        const currentFeatures = featuresRef.current
        if (currentFeatures && currentFeatures.length > 0) {
          const updatedFeatures: HexFeature[] = currentFeatures.map((f) => ({
            ...f,
            properties: {
              ...f.properties,
              selected: f.properties.h3Index === h3Index,
            },
          }))

          featuresRef.current = updatedFeatures

          const updatedCollection = {
            type: 'FeatureCollection' as const,
            features: updatedFeatures,
          }

          const source = map.getSource('h3-hex') as maplibregl.GeoJSONSource | undefined
          if (source) {
            source.setData(updatedCollection)
          }
        }
      })
    })

    return () => {
      map.remove()
    }
  }, [])

  // Load demo user balance on mount
  useEffect(() => {
    const loadUser = async () => {
      try {
        const res = await fetch(`${apiBase}/api/user`)
        if (res.ok) {
          const data: { balance?: number; ownedCount?: number } = await res.json()
          if (typeof data.balance === 'number') {
            setUserBalance(data.balance)
          }
          if (typeof data.ownedCount === 'number') {
            setOwnedCount(data.ownedCount)
          }
        }
      } catch {
        // ignore load errors for now
      }
    }

    void loadUser()
  }, [])

  const handleMineClick = () => {
    if (!selectedHex) {
      return
    }

    const { h3Index, zoneType } = selectedHex

    if (zoneType === 'MAIN_ROAD') {
      setMineMessage('Mining on a main road hex is not allowed in normal mode (only by flying above 300 km/h).')
      setMineMessageType('error')
      return
    }

    if (zoneType === 'MILITARY' || zoneType === 'HOSPITAL' || zoneType === 'CLIFF') {
      setMineMessage('Mining on this hex is forbidden for safety or legal reasons.')
      setMineMessageType('error')
      return
    }

    const doMine = async () => {
      try {
        const res = await fetch(`${apiBase}/api/mine`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ h3Index }),
        })

        if (!res.ok) {
          setMineMessage('Mining failed due to a server error.')
          setMineMessageType('error')
          return
        }

        const data: { ok?: boolean; balance?: number; reason?: string } = await res.json()

        if (!data.ok) {
          if (data.reason === 'ALREADY_MINED') {
            setMineMessage('This hex has already been mined for this user.')
          } else {
            setMineMessage('Mining was not accepted.')
          }
          setMineMessageType('error')
          if (typeof data.balance === 'number') {
            setUserBalance(data.balance)
          }
          return
        }

        if (typeof data.balance === 'number') {
          setUserBalance(data.balance)
        }

        setSelectedOwned(true)

        ownedHexesRef.current.add(h3Index)

        const currentFeatures = featuresRef.current
        if (!currentFeatures || currentFeatures.length === 0 || !mapRef.current) {
          setMineMessage(`Hex ${h3Index} mined, but map state could not be updated.`)
          setMineMessageType('error')
          return
        }

        const updatedFeatures: HexFeature[] = currentFeatures.map((f) => {
          if (f.properties.h3Index === h3Index) {
            return {
              ...f,
              properties: {
                ...f.properties,
                claimed: true,
              },
            }
          }
          return f
        })

        featuresRef.current = updatedFeatures

        const updatedCollection = {
          type: 'FeatureCollection' as const,
          features: updatedFeatures,
        }

        const map = mapRef.current
        const source = map.getSource('h3-hex') as maplibregl.GeoJSONSource | undefined
        if (source) {
          source.setData(updatedCollection)
        }

        setMineMessage(`Hex ${h3Index} mined successfully.`)
        setMineMessageType('success')
      } catch {
        setMineMessage('Mining failed due to a network error.')
        setMineMessageType('error')
      }
    }

    void doMine()
  }

  const handleCloseInfoPanel = () => {
    setSelectedInfo(null)
    setSelectedHex(null)
    setSelectedDebug(null)
    setSelectedOwned(null)
    setMineMessage(null)
    setMineMessageType(null)
  }

  const handleUseMyLocationClick = () => {
    if (!navigator.geolocation) {
      // Browser does not support geolocation
      setToastMessage('Geolocation is not supported by this browser.')
      setToastType('error')
      return
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const { latitude, longitude } = position.coords
        const map = mapRef.current
        if (!map) return

        map.flyTo({ center: [longitude, latitude], zoom: 14 })

        setToastMessage(
          `Moved to location: lat ${latitude.toFixed(5)}, lon ${longitude.toFixed(5)}`,
        )
        setToastType('success')
      },
      (error) => {
        const map = mapRef.current
        // If permission denied or other error, we surface a simple toast message.
        setToastMessage(error.message || 'Failed to get current location.')
        setToastType('error')

        // Optionally we could fall back to keeping the current view; do nothing.
        if (!map) return
      },
    )
  }

  return (
    <div className="app-root">
      <div className="map-wrapper">
        <div ref={mapContainerRef} className="map-container" />
        <button
          type="button"
          className="use-location-button"
          onClick={handleUseMyLocationClick}
        >
          Use my location
        </button>
      </div>
      <div className="hud-panel">
        <div className="hud-line">
          <span className="hud-label">Balance:</span>{' '}
          <span className="hud-value">{typeof userBalance === 'number' ? userBalance : '-'}</span>
        </div>
        <div className="hud-line">
          <span className="hud-label">Owned hexes:</span>{' '}
          <span className="hud-value">{typeof ownedCount === 'number' ? ownedCount : '-'}</span>
        </div>
      </div>
      {toastMessage && (
        <div
          className={
            toastType === 'success'
              ? 'toast toast-success'
              : toastType === 'error'
                ? 'toast toast-error'
                : 'toast'
          }
        >
          {toastMessage}
        </div>
      )}
      {selectedInfo && (
        <div className="info-panel">
          <div className="info-header">
            <div className="info-title">
              Hex details
              {typeof userBalance === 'number' && (
                <span style={{ fontWeight: 400, marginLeft: 8, fontSize: '0.8rem' }}>
                  | Balance: {userBalance}
                </span>
              )}
            </div>
            <button
              type="button"
              className="info-close-button"
              onClick={handleCloseInfoPanel}
              aria-label="Close hex details"
            >
              ×
            </button>
          </div>
          <div className="info-lines">
            {selectedInfo.split('\n').map((line) => (
              <div key={line} className="info-line">
                {line}
              </div>
            ))}
          </div>
          {selectedHex && (
            <div className="info-line">
              Owned:{' '}
              {selectedOwned == null ? 'Unknown' : selectedOwned ? 'Yes' : 'No'}
            </div>
          )}
          {selectedHex && (
            <button type="button" className="mine-button" onClick={handleMineClick}>
              Mine this hex
            </button>
          )}
          {mineMessage && (
            <div
              className={
                mineMessageType === 'success'
                  ? 'mine-message mine-message-success'
                  : mineMessageType === 'error'
                    ? 'mine-message mine-message-error'
                    : 'mine-message'
              }
            >
              {mineMessage}
            </div>
          )}
          {Array.isArray(selectedDebug) && selectedDebug.length > 0 && (
            <div>
              <div className="info-debug-title">OSM debug:</div>
              {selectedDebug.map((line, idx) => (
                <div key={idx} className="info-debug-line">
                  {line}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default App
