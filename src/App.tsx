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

  const [viewMode, setViewMode] = useState<'MAP' | 'TRADE' | 'STATS'>('MAP')

  const [usdtBalance, setUsdtBalance] = useState<number | null>(null)
  const [lastPrice, setLastPrice] = useState<number | null>(null)
  const [tradeCount24h, setTradeCount24h] = useState<number | null>(null)
  const [volume24h, setVolume24h] = useState<number | null>(null)
  const [recentTrades, setRecentTrades] = useState<
    { id: string; side: 'BUY' | 'SELL'; price: number; amount: number; timestamp: number }[]
  >([])

  const [minedStats, setMinedStats] = useState<
    { day: string; daily: number; cumulative: number }[]
  >([])

  const [orderSide, setOrderSide] = useState<'BUY' | 'SELL'>('BUY')
  const [orderPrice, setOrderPrice] = useState<string>('')
  const [orderAmount, setOrderAmount] = useState<string>('')
  const [orderSubmitting, setOrderSubmitting] = useState(false)
  const [orderError, setOrderError] = useState<string | null>(null)
  const featuresRef = useRef<HexFeature[]>([])
  const ownedHexesRef = useRef<Set<string>>(new Set())
  const hexInfoCacheRef = useRef<
    Map<
      string,
      {
        zoneType: ZoneType
        debugInfo: string[]
      }
    >
  >(new Map())

  useEffect(() => {
    if (!mapContainerRef.current) return

    const centerLonLat: [number, number] = [34.7818, 32.0853]
    const h3Resolution = 11

    const mapStyleUrl =
      import.meta.env.VITE_MAP_STYLE_URL ??
      'https://api.maptiler.com/maps/dataviz-v4/style.json?key=EAB6uPDrtlRzXsFngjM4'

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
      let lastLoadCenter: { lat: number; lng: number } | null = null
      let lastLoadTime = 0

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

        // Instead of using the full viewport bounds (which can cover a large
        // area and trigger many Overpass calls), only consider a small square
        // around the map center. This better matches the gameplay, where the
        // player can usually mine only nearby hexes.
        const center = map.getCenter()
        const centerLat = center.lat
        const centerLng = center.lng

        const now = Date.now()
        const minIntervalMs = 1500

        if (lastLoadCenter) {
          const dLat = Math.abs(centerLat - lastLoadCenter.lat)
          const dLng = Math.abs(centerLng - lastLoadCenter.lng)
          const movedFarEnough = dLat > 0.0007 || dLng > 0.0007
          const enoughTimePassed = now - lastLoadTime > minIntervalMs

          // If the map center only moved a tiny amount and not enough time has
          // passed, skip reloading hexes to avoid spamming the backend.
          if (!movedFarEnough && !enoughTimePassed) {
            return
          }
        }

        lastLoadCenter = { lat: centerLat, lng: centerLng }
        lastLoadTime = now

        // Always refresh owned hexes from the backend before rebuilding features,
        // so that claimed state is correct after reload or viewport changes.
        await loadOwnedHexes()

        // Roughly ~150m radius in degrees (depends on latitude, but good
        // enough for our purposes). This keeps the number of hexes per load
        // relatively small.
        const deltaLat = 0.0015
        const deltaLng = 0.0015

        const south = centerLat - deltaLat
        const north = centerLat + deltaLat
        const west = centerLng - deltaLng
        const east = centerLng + deltaLng

        // h3-js expects coordinates in [lat, lng] order. Build a small
        // rectangle polygon centred on the current map center.
        const polygon: number[][][] = [[
          [south, west],
          [south, east],
          [north, east],
          [north, west],
          [south, west],
        ]]

        const hexIndexes = h3.polygonToCells(polygon, h3Resolution, true)

        const ownedSet = ownedHexesRef.current
        const infoCache = hexInfoCacheRef.current

        const newFeatures: HexFeature[] = []

        for (const hexIndex of hexIndexes) {
          const boundary = h3.cellToBoundary(hexIndex, true)
          const coords = boundary.map(([lat, lng]) => [lng, lat])
          coords.push(coords[0])

          let zoneType: ZoneType = 'URBAN'
          let debugInfo: string[] = []

          const cached = infoCache.get(hexIndex)
          if (cached) {
            zoneType = cached.zoneType
            debugInfo = cached.debugInfo
          } else {
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

            infoCache.set(hexIndex, {
              zoneType,
              debugInfo,
            })
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

  useEffect(() => {
    const loadBalances = async () => {
      try {
        const res = await fetch(`${apiBase}/api/market/balance`)
        if (!res.ok) return
        const data: { ghx?: number; usdt?: number } = await res.json()
        if (typeof data.ghx === 'number') {
          setUserBalance(data.ghx)
        }
        if (typeof data.usdt === 'number') {
          setUsdtBalance(data.usdt)
        }
      } catch {
        // ignore
      }
    }

    const loadTicker = async () => {
      try {
        const res = await fetch(`${apiBase}/api/market/ticker`)
        if (!res.ok) return
        const data: { lastPrice: number | null; volume24h?: number; trades?: number } = await res.json()
        setLastPrice(data.lastPrice)
        if (typeof data.volume24h === 'number') {
          setVolume24h(data.volume24h)
        }
        if (typeof data.trades === 'number') {
          setTradeCount24h(data.trades)
        }
      } catch {
        // ignore
      }
    }

    const loadTrades = async () => {
      try {
        const res = await fetch(`${apiBase}/api/market/trades`)
        if (!res.ok) return
        const data: {
          trades?: { id: string; side: 'BUY' | 'SELL'; price: number; amount: number; timestamp: number }[]
        } = await res.json()
        if (Array.isArray(data.trades)) {
          setRecentTrades(data.trades)
        }
      } catch {
        // ignore
      }
    }

    void loadBalances()
    void loadTicker()
    void loadTrades()

    const interval = window.setInterval(() => {
      void loadBalances()
      void loadTicker()
      void loadTrades()
    }, 10_000)

    return () => {
      window.clearInterval(interval)
    }
  }, [apiBase])

  useEffect(() => {
    const loadMinedStats = async () => {
      try {
        const res = await fetch(`${apiBase}/api/stats/mined`)
        if (!res.ok) return

        const data: { points?: { day: string; daily: number; cumulative: number }[] } = await res.json()
        if (Array.isArray(data.points)) {
          setMinedStats(data.points)
        }
      } catch {
        // ignore
      }
    }

    void loadMinedStats()
  }, [apiBase])

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
      <div className="top-bar">
        <div className="top-bar-title">GeoHex Miner</div>
        <div className="top-bar-tabs">
          <button
            type="button"
            className={viewMode === 'MAP' ? 'top-bar-tab top-bar-tab-active' : 'top-bar-tab'}
            onClick={() => setViewMode('MAP')}
          >
            Map
          </button>
          <button
            type="button"
            className={viewMode === 'TRADE' ? 'top-bar-tab top-bar-tab-active' : 'top-bar-tab'}
            onClick={() => setViewMode('TRADE')}
          >
            Trade
          </button>
          <button
            type="button"
            className={viewMode === 'STATS' ? 'top-bar-tab top-bar-tab-active' : 'top-bar-tab'}
            onClick={() => setViewMode('STATS')}
          >
            Stats
          </button>
        </div>
      </div>

      {viewMode === 'MAP' && (
        <>
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
              <span className="hud-label">GHX balance:</span>{' '}
              <span className="hud-value">
                {typeof userBalance === 'number' ? userBalance : '-'}
              </span>
            </div>
            <div className="hud-line">
              <span className="hud-label">Owned hexes:</span>{' '}
              <span className="hud-value">{typeof ownedCount === 'number' ? ownedCount : '-'}</span>
            </div>
          </div>
        </>
      )}

      {viewMode === 'TRADE' && (
        <div className="trade-panel">
          <div className="trade-header">
            <div className="trade-pair">GHX / USDT</div>
            <div className="trade-ticker">
              <div className="trade-ticker-line">
                <span className="trade-ticker-label">Last price:</span>
                <span className="trade-ticker-value">
                  {lastPrice != null ? `${lastPrice.toFixed(4)} USDT` : '-'}
                </span>
              </div>
              <div className="trade-ticker-line">
                <span className="trade-ticker-label">24h volume:</span>
                <span className="trade-ticker-value">
                  {volume24h != null ? volume24h.toFixed(2) : '-'} GHX
                </span>
              </div>
              <div className="trade-ticker-line">
                <span className="trade-ticker-label">24h trades:</span>
                <span className="trade-ticker-value">
                  {tradeCount24h != null ? tradeCount24h : '-'}
                </span>
              </div>
            </div>
          </div>

          <div className="trade-balances">
            <div className="trade-balance-line">
              <span className="trade-balance-label">GHX:</span>
              <span className="trade-balance-value">
                {typeof userBalance === 'number' ? userBalance.toFixed(4) : '-'}
              </span>
            </div>
            <div className="trade-balance-line">
              <span className="trade-balance-label">USDT:</span>
              <span className="trade-balance-value">
                {typeof usdtBalance === 'number' ? usdtBalance.toFixed(2) : '-'}
              </span>
            </div>
          </div>

          <div className="trade-layout">
            <div className="trade-form">
              <div className="trade-form-side-toggle">
                <button
                  type="button"
                  className={orderSide === 'BUY' ? 'trade-side-button trade-side-button-buy active' : 'trade-side-button trade-side-button-buy'}
                  onClick={() => {
                    setOrderSide('BUY')
                    setOrderError(null)
                  }}
                >
                  Buy
                </button>
                <button
                  type="button"
                  className={orderSide === 'SELL' ? 'trade-side-button trade-side-button-sell active' : 'trade-side-button trade-side-button-sell'}
                  onClick={() => {
                    setOrderSide('SELL')
                    setOrderError(null)
                  }}
                >
                  Sell
                </button>
              </div>

              <label className="trade-input-label">
                Price (USDT per GHX)
                <input
                  className="trade-input"
                  type="number"
                  min="0"
                  step="0.0001"
                  value={orderPrice}
                  onChange={(e) => setOrderPrice(e.target.value)}
                />
              </label>

              <label className="trade-input-label">
                Amount (GHX)
                <input
                  className="trade-input"
                  type="number"
                  min="0"
                  step="0.0001"
                  value={orderAmount}
                  onChange={(e) => setOrderAmount(e.target.value)}
                />
              </label>

              <div className="trade-total-line">
                <span>Total:</span>
                <span>
                  {orderPrice && orderAmount
                    ? `${(Number(orderPrice) * Number(orderAmount)).toFixed(4)} USDT`
                    : '-'}
                </span>
              </div>

              {orderError && <div className="trade-error">{orderError}</div>}

              <button
                type="button"
                className={
                  orderSide === 'BUY'
                    ? 'trade-submit-button trade-submit-button-buy'
                    : 'trade-submit-button trade-submit-button-sell'
                }
                disabled={orderSubmitting}
                onClick={async () => {
                  setOrderError(null)
                  const price = Number(orderPrice)
                  const amount = Number(orderAmount)

                  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(amount) || amount <= 0) {
                    setOrderError('Please enter a valid positive price and amount.')
                    return
                  }

                  setOrderSubmitting(true)
                  try {
                    const res = await fetch(`${apiBase}/api/market/order`, {
                      method: 'POST',
                      headers: {
                        'Content-Type': 'application/json',
                      },
                      body: JSON.stringify({ side: orderSide, price, amount }),
                    })

                    if (!res.ok) {
                      const text = await res.text()
                      setOrderError(text || 'Order failed.')
                      return
                    }

                    const data: {
                      ok?: boolean
                      error?: string
                      trade?: { id: string; side: 'BUY' | 'SELL'; price: number; amount: number; timestamp: number }
                      balances?: { ghx?: number; usdt?: number }
                    } = await res.json()

                    if (!data.ok) {
                      setOrderError(data.error || 'Order was not accepted.')
                      return
                    }

                    if (data.balances) {
                      if (typeof data.balances.ghx === 'number') {
                        setUserBalance(data.balances.ghx)
                      }
                      if (typeof data.balances.usdt === 'number') {
                        setUsdtBalance(data.balances.usdt)
                      }
                    }

                    if (data.trade) {
                      setLastPrice(data.trade.price)
                      setRecentTrades((prev) => [data.trade!, ...prev].slice(0, 100))
                    }

                    setOrderPrice('')
                    setOrderAmount('')
                  } catch {
                    setOrderError('Order failed due to a network error.')
                  } finally {
                    setOrderSubmitting(false)
                  }
                }}
              >
                {orderSubmitting ? 'Submitting…' : orderSide === 'BUY' ? 'Buy GHX' : 'Sell GHX'}
              </button>
            </div>

            <div className="trade-recent-trades">
              <div className="trade-recent-title">Recent trades</div>
              {recentTrades.length === 0 && (
                <div className="trade-recent-empty">No trades yet.</div>
              )}
              {recentTrades.length > 0 && (
                <div className="trade-recent-list">
                  {recentTrades.slice(0, 40).map((t) => {
                    const date = new Date(t.timestamp)
                    return (
                      <div
                        key={t.id}
                        className={
                          t.side === 'BUY' ? 'trade-recent-row trade-recent-row-buy' : 'trade-recent-row trade-recent-row-sell'
                        }
                      >
                        <span className="trade-recent-time">
                          {date.toLocaleTimeString(undefined, {
                            hour: '2-digit',
                            minute: '2-digit',
                            second: '2-digit',
                          })}
                        </span>
                        <span className="trade-recent-side">{t.side}</span>
                        <span className="trade-recent-price">{t.price.toFixed(4)}</span>
                        <span className="trade-recent-amount">{t.amount.toFixed(4)} GHX</span>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      {viewMode === 'STATS' && (
        <div className="stats-panel">
          <div className="stats-header">Mined GHX over time</div>
          {minedStats.length === 0 && (
            <div className="stats-empty">No mining data yet.</div>
          )}
          {minedStats.length > 0 && (
            <div className="stats-chart-wrapper">
              {(() => {
                const width = 360
                const height = 180
                const paddingLeft = 32
                const paddingRight = 8
                const paddingTop = 16
                const paddingBottom = 24

                const xs = minedStats.map((_, i) => i)
                const ys = minedStats.map((p) => p.cumulative)
                const minX = 0
                const maxX = Math.max(1, xs.length - 1)
                const minY = 0
                const maxY = Math.max(1, Math.max(...ys))

                const plotWidth = width - paddingLeft - paddingRight
                const plotHeight = height - paddingTop - paddingBottom

                const scaleX = (i: number) =>
                  paddingLeft + (plotWidth * (xs.length === 1 ? 0.5 : i / maxX))
                const scaleY = (v: number) =>
                  paddingTop + plotHeight - (plotHeight * (maxY === minY ? 0 : (v - minY) / (maxY - minY)))

                const pathD = minedStats
                  .map((p, i) => {
                    const x = scaleX(i)
                    const y = scaleY(p.cumulative)
                    return `${i === 0 ? 'M' : 'L'} ${x} ${y}`
                  })
                  .join(' ')

                const lastPoint = minedStats[minedStats.length - 1]

                return (
                  <svg
                    className="stats-chart"
                    width={width}
                    height={height}
                    viewBox={`0 0 ${width} ${height}`}
                  >
                    <rect
                      x={paddingLeft}
                      y={paddingTop}
                      width={plotWidth}
                      height={plotHeight}
                      fill="#06090f"
                      stroke="#1f2937"
                      strokeWidth={1}
                    />
                    {minedStats.length > 1 && (
                      <>
                        <line
                          x1={paddingLeft}
                          y1={scaleY(0)}
                          x2={paddingLeft + plotWidth}
                          y2={scaleY(0)}
                          stroke="#111827"
                          strokeWidth={1}
                        />
                        <line
                          x1={paddingLeft}
                          y1={scaleY(maxY)}
                          x2={paddingLeft + plotWidth}
                          y2={scaleY(maxY)}
                          stroke="#111827"
                          strokeWidth={1}
                        />
                      </>
                    )}
                    <path d={pathD} fill="none" stroke="#22c55e" strokeWidth={2} />
                    {minedStats.map((p, i) => {
                      const x = scaleX(i)
                      const y = scaleY(p.cumulative)
                      return (
                        <circle key={p.day} cx={x} cy={y} r={2.2} fill="#22c55e" />
                      )
                    })}
                    <text
                      x={paddingLeft}
                      y={height - 6}
                      fill="#9ca3af"
                      fontSize={10}
                    >
                      {minedStats[0]?.day}
                    </text>
                    <text
                      x={width - paddingRight}
                      y={height - 6}
                      fill="#9ca3af"
                      fontSize={10}
                      textAnchor="end"
                    >
                      {lastPoint.day}
                    </text>
                    <text
                      x={paddingLeft + 4}
                      y={paddingTop + 12}
                      fill="#9ca3af"
                      fontSize={10}
                    >
                      Total: {lastPoint.cumulative}
                    </text>
                  </svg>
                )
              })()}
              <div className="stats-legend">
                <div className="stats-legend-item">
                  <span className="stats-legend-color" />
                  <span>Cumulative mined GHX</span>
                </div>
              </div>
              <div className="stats-table">
                <div className="stats-table-header">
                  <span>Day</span>
                  <span>Daily</span>
                  <span>Cumulative</span>
                </div>
                {minedStats.map((p) => (
                  <div key={p.day} className="stats-table-row">
                    <span>{p.day}</span>
                    <span>{p.daily}</span>
                    <span>{p.cumulative}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
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
      {viewMode === 'MAP' && selectedInfo && (
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
