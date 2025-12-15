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

  const toastTimerRef = useRef<number | null>(null)
  const geoWatchIdRef = useRef<number | null>(null)
  const lastGeoCoordsRef = useRef<{ lon: number; lat: number; accuracyM: number; headingDeg: number | null } | null>(
    null,
  )
  const lastAutoSelectHexRef = useRef<string | null>(null)
  const lastAutoMineHexRef = useRef<string | null>(null)
  const lastAutoMineAtRef = useRef<number>(0)
  const lastFollowAtRef = useRef<number>(0)

  const [authToken, setAuthToken] = useState<string | null>(() => {
    try {
      return localStorage.getItem('ghxAuthToken')
    } catch {
      return null
    }
  })

  const setAndPersistAuthToken = (token: string | null) => {
    setAuthToken(token)
    try {
      if (token) {
        localStorage.setItem('ghxAuthToken', token)
      } else {
        localStorage.removeItem('ghxAuthToken')
      }
    } catch {
      // ignore storage errors
    }
  }

  const authedFetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    if (authToken) {
      headers.set('Authorization', `Bearer ${authToken}`)
    }
    return fetch(input, { ...init, headers })
  }

  type ZoneType =
    | 'SEA'
    | 'MAIN_ROAD'
    | 'URBAN'
    | 'INTERURBAN'
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

  const handleAuthRegister = () => {
    const doRegister = async () => {
      setAuthSubmitting(true)
      setAuthError(null)
      try {
        const res = await fetch(`${apiBase}/api/auth/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: authEmail, password: authPassword }),
        })

        const data: { ok?: boolean; token?: string; error?: string } = await res.json().catch(() => ({}))
        if (!res.ok || !data.ok || !data.token) {
          setAuthError(data.error ?? 'Registration failed.')
          return
        }

        setAndPersistAuthToken(data.token)
        setToastMessage('Registration successful. You are now logged in.')
        setToastType('success')
        setAuthPassword('')
        setViewMode('MAP')
      } catch {
        setAuthError('Network error during registration.')
      } finally {
        setAuthSubmitting(false)
      }
    }

    void doRegister()
  }

  const handleAuthLogin = () => {
    const doLogin = async () => {
      setAuthSubmitting(true)
      setAuthError(null)
      try {
        const res = await fetch(`${apiBase}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: authEmail, password: authPassword }),
        })

        const data: { ok?: boolean; token?: string; error?: string } = await res.json().catch(() => ({}))
        if (!res.ok || !data.ok || !data.token) {
          setAuthError(data.error ?? 'Login failed.')
          return
        }

        setAndPersistAuthToken(data.token)
        setToastMessage('Logged in successfully.')
        setToastType('success')
        setAuthPassword('')
        setViewMode('MAP')
      } catch {
        setAuthError('Network error during login.')
      } finally {
        setAuthSubmitting(false)
      }
    }

    void doLogin()
  }

  const handleLogout = () => {
    setAndPersistAuthToken(null)
    setAccountInfo(null)
    ownedHexesRef.current = new Set()
    setUserBalance(null)
    setOwnedCount(null)
    setUsdtBalance(null)
    setToastMessage('Logged out.')
    setToastType('success')
  }

  const handleToggleDriveMode = () => {
    setDriveModeActive((prev) => {
      const next = !prev
      driveModeActiveRef.current = next
      if (!next) {
        lastDriveHexRef.current = null
        setToastMessage('Drive Mode turned off.')
        setToastType('success')
      } else {
        setToastMessage('Drive Mode turned on. Click road hexes to simulate driving.')
        setToastType('success')
      }
      return next
    })
  }

  const miningRules: Record<ZoneType, MiningRule> = {
    URBAN: {
      minSpeedKmh: null,
      description: 'Urban area.',
    },
    INTERURBAN: {
      minSpeedKmh: null,
      description: 'Interurban area / open land between cities.',
    },
    MAIN_ROAD: {
      minSpeedKmh: null,
      description: 'Main road / major traffic corridor.',
    },
    SEA: {
      minSpeedKmh: null,
      description: 'Sea / open water.',
    },
    NATURE_RESERVE: {
      minSpeedKmh: null,
      description: 'Nature reserve / forest / large green area.',
    },
    RIVER: {
      minSpeedKmh: null,
      description: 'River / stream / canal.',
    },
    MILITARY: {
      minSpeedKmh: null,
      description: 'Military or similarly sensitive zone.',
    },
    HOSPITAL: {
      minSpeedKmh: null,
      description: 'Hospital or medical facility area.',
    },
    CLIFF: {
      minSpeedKmh: null,
      description: 'Cliff / steep or dangerous terrain.',
    },
    COAST: {
      minSpeedKmh: null,
      description: 'Coastline / beach edge.',
    },
  }

  type HexFeature = {
    type: 'Feature'
    properties: {
      h3Index: string
      zoneType: ZoneType
      claimed: boolean
      selected: boolean
      canMine: boolean
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
  const [canSpawnHere, setCanSpawnHere] = useState(false)
  const [userBalance, setUserBalance] = useState<number | null>(null)
  const [ownedCount, setOwnedCount] = useState<number | null>(null)
  const [toastMessage, setToastMessage] = useState<string | null>(null)
  const [toastType, setToastType] = useState<'success' | 'error' | null>(null)
  const [followMyLocation, setFollowMyLocation] = useState(false)
  const [driveModeActive, setDriveModeActive] = useState(false)
  const driveModeActiveRef = useRef(false)
  const lastDriveHexRef = useRef<string | null>(null)

  const buildCirclePolygon = (lon: number, lat: number, radiusM: number) => {
    const steps = 60
    const earthRadiusM = 6378137
    const latRad = (lat * Math.PI) / 180
    const coords: [number, number][] = []

    for (let i = 0; i <= steps; i++) {
      const angle = (i / steps) * 2 * Math.PI
      const dx = Math.cos(angle) * radiusM
      const dy = Math.sin(angle) * radiusM

      const dLat = (dy / earthRadiusM) * (180 / Math.PI)
      const dLon = (dx / (earthRadiusM * Math.cos(latRad))) * (180 / Math.PI)
      coords.push([lon + dLon, lat + dLat])
    }

    return {
      type: 'FeatureCollection' as const,
      features: [
        {
          type: 'Feature' as const,
          properties: {},
          geometry: {
            type: 'Polygon' as const,
            coordinates: [coords],
          },
        },
      ],
    }
  }

  const buildHeadingConePolygon = (lon: number, lat: number, headingDeg: number, lengthM: number) => {
    const earthRadiusM = 6378137
    const latRad = (lat * Math.PI) / 180
    const headingRad = (headingDeg * Math.PI) / 180
    const halfAngleRad = (26 * Math.PI) / 180
    const steps = 18

    const coords: [number, number][] = []
    coords.push([lon, lat])

    for (let i = 0; i <= steps; i++) {
      const t = i / steps
      const a = headingRad - halfAngleRad + t * (2 * halfAngleRad)
      const dx = Math.sin(a) * lengthM
      const dy = Math.cos(a) * lengthM
      const dLat = (dy / earthRadiusM) * (180 / Math.PI)
      const dLon = (dx / (earthRadiusM * Math.cos(latRad))) * (180 / Math.PI)
      coords.push([lon + dLon, lat + dLat])
    }

    coords.push([lon, lat])

    return {
      type: 'FeatureCollection' as const,
      features: [
        {
          type: 'Feature' as const,
          properties: {},
          geometry: {
            type: 'Polygon' as const,
            coordinates: [coords],
          },
        },
      ],
    }
  }

  const setMapUserLocation = (coords: { lon: number; lat: number; accuracyM: number; headingDeg: number | null }) => {
    lastGeoCoordsRef.current = coords
    const map = mapRef.current
    if (!map) return

    try {
      const pointSource = map.getSource('user-location') as maplibregl.GeoJSONSource | undefined
      if (pointSource) {
        pointSource.setData({
          type: 'FeatureCollection' as const,
          features: [
            {
              type: 'Feature' as const,
              properties: { heading: coords.headingDeg },
              geometry: { type: 'Point' as const, coordinates: [coords.lon, coords.lat] },
            },
          ],
        })
      }

      const accuracySource = map.getSource('user-accuracy') as maplibregl.GeoJSONSource | undefined
      if (accuracySource) {
        accuracySource.setData(buildCirclePolygon(coords.lon, coords.lat, Math.max(6, coords.accuracyM)))
      }

      const headingSource = map.getSource('user-heading') as maplibregl.GeoJSONSource | undefined
      if (headingSource) {
        if (typeof coords.headingDeg === 'number' && Number.isFinite(coords.headingDeg)) {
          headingSource.setData(buildHeadingConePolygon(coords.lon, coords.lat, coords.headingDeg, Math.max(40, coords.accuracyM * 1.6)))
        } else {
          headingSource.setData({ type: 'FeatureCollection' as const, features: [] as any[] })
        }
      }

      // Follow mode: keep the map centered on the user while enabled.
      if (followMyLocation) {
        const now = Date.now()
        if (now - lastFollowAtRef.current > 350) {
          lastFollowAtRef.current = now
          const desiredZoom = driveModeActiveRef.current ? 16.5 : 15.8
          const bearing = typeof coords.headingDeg === 'number' && Number.isFinite(coords.headingDeg) ? coords.headingDeg : undefined
          map.easeTo({
            center: [coords.lon, coords.lat],
            zoom: desiredZoom,
            bearing,
            duration: 650,
          })
        }
      }

      // Auto-select current hex (orange highlight) when accuracy is good enough.
      // We do not open the info panel; we only update selection state.
      const autoSelectAccuracyThresholdM = 35
      if (coords.accuracyM <= autoSelectAccuracyThresholdM) {
        const h3Resolution = 11
        let currentHex: string | null = null
        try {
          currentHex = h3.latLngToCell(coords.lat, coords.lon, h3Resolution)
        } catch {
          currentHex = null
        }

        if (currentHex && currentHex !== lastAutoSelectHexRef.current) {
          lastAutoSelectHexRef.current = currentHex

          const currentFeatures = featuresRef.current
          const selectedFeature = currentFeatures.find((f) => f.properties.h3Index === currentHex)
          if (selectedFeature) {
            const zoneType = selectedFeature.properties.zoneType
            setSelectedHex({ h3Index: currentHex, zoneType })
            setSelectedOwned(ownedHexesRef.current.has(currentHex))
            setMineMessage(null)
            setMineMessageType(null)
            setCanSpawnHere(false)

            const updatedFeatures: HexFeature[] = currentFeatures.map((f) => ({
              ...f,
              properties: {
                ...f.properties,
                selected: f.properties.h3Index === currentHex,
              },
            }))

            featuresRef.current = updatedFeatures
            const source = map.getSource('h3-hex') as maplibregl.GeoJSONSource | undefined
            if (source) {
              source.setData({ type: 'FeatureCollection' as const, features: updatedFeatures })
            }

            // Auto-mine road hexes while Drive Mode is active.
            const shouldAutoMine =
              driveModeActiveRef.current &&
              authToken &&
              zoneType === 'MAIN_ROAD' &&
              !ownedHexesRef.current.has(currentHex) &&
              currentHex !== lastAutoMineHexRef.current

            if (shouldAutoMine) {
              const now = Date.now()
              const minIntervalMs = 1200
              if (now - lastAutoMineAtRef.current >= minIntervalMs) {
                lastAutoMineAtRef.current = now
                lastAutoMineHexRef.current = currentHex

                void (async () => {
                  try {
                    const res = await authedFetch(`${apiBase}/api/mine`, {
                      method: 'POST',
                      headers: {
                        'Content-Type': 'application/json',
                      },
                      body: JSON.stringify({ h3Index: currentHex }),
                    })

                    if (!res.ok) {
                      return
                    }

                    const data: { ok?: boolean; balance?: number; reason?: string } = await res.json().catch(() => ({}))
                    if (!data.ok) {
                      return
                    }

                    if (typeof data.balance === 'number') {
                      setUserBalance(data.balance)
                    }

                    setOwnedCount((prev) => (typeof prev === 'number' ? prev + 1 : prev))
                    ownedHexesRef.current.add(currentHex)
                    setSelectedOwned(true)

                    const ownedSet = ownedHexesRef.current
                    const refreshedFeatures = featuresRef.current
                    const nextFeatures: HexFeature[] = refreshedFeatures.map((f) => {
                      const idx = f.properties.h3Index
                      const isOwned = ownedSet.has(idx)
                      const neighbors = h3.gridDisk(idx, 1)
                      const canMine = !isOwned && neighbors.some((n) => ownedSet.has(n))
                      return {
                        ...f,
                        properties: {
                          ...f.properties,
                          claimed: isOwned,
                          canMine,
                        },
                      }
                    })

                    featuresRef.current = nextFeatures
                    const source = map.getSource('h3-hex') as maplibregl.GeoJSONSource | undefined
                    if (source) {
                      source.setData({ type: 'FeatureCollection' as const, features: nextFeatures })
                    }
                  } catch {
                    // ignore network errors
                  }
                })()
              }
            }
          }
        }
      }
    } catch {
      // ignore if map was destroyed or sources not ready
    }
  }

  useEffect(() => {
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current)
      toastTimerRef.current = null
    }

    if (!toastMessage) {
      return
    }

    toastTimerRef.current = window.setTimeout(() => {
      setToastMessage(null)
      setToastType(null)
      toastTimerRef.current = null
    }, 3200)

    return () => {
      if (toastTimerRef.current !== null) {
        window.clearTimeout(toastTimerRef.current)
        toastTimerRef.current = null
      }
    }
  }, [toastMessage])
  const [showVeins, setShowVeins] = useState(false)

  // Used to force a full MapLibre re-initialisation when needed (e.g. when
  // returning from the Trade/Stats views and the map ends up black). Changing
  // this seed will re-run the map setup effect and create a fresh map instance
  // in the existing container.
  const [mapInstanceSeed, setMapInstanceSeed] = useState(0)

  const [viewMode, setViewMode] = useState<'MAP' | 'TRADE' | 'STATS' | 'POLICY' | 'ACCOUNT'>('MAP')

  const [usdtBalance, setUsdtBalance] = useState<number | null>(null)
  const [lastPrice, setLastPrice] = useState<number | null>(null)
  const [tradeCount24h, setTradeCount24h] = useState<number | null>(null)
  const [volume24h, setVolume24h] = useState<number | null>(null)
  const [vwap24h, setVwap24h] = useState<number | null>(null)
  const [change24h, setChange24h] = useState<number | null>(null)
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
  const mapStyleUrlRef = useRef<string | null>(null)
  const hexInfoCacheRef = useRef<
    Map<
      string,
      {
        zoneType: ZoneType
        debugInfo: string[]
      }
    >
  >(new Map())

  type AccountInfo = {
    id: string
    ghxBalance: number
    usdtBalance: number
    ownedCount: number
    ownedHexes: string[]
  }

  const [accountInfo, setAccountInfo] = useState<AccountInfo | null>(null)
  const [accountLoading, setAccountLoading] = useState(false)
  const [accountError, setAccountError] = useState<string | null>(null)

  const [authEmail, setAuthEmail] = useState('')
  const [authPassword, setAuthPassword] = useState('')
  const [authSubmitting, setAuthSubmitting] = useState(false)
  const [authError, setAuthError] = useState<string | null>(null)

  useEffect(() => {
    if (!mapContainerRef.current) return

    const centerLonLat: [number, number] = [34.7818, 32.0853]
    const h3Resolution = 11

    const mapStyleUrl =
      import.meta.env.VITE_MAP_STYLE_URL ??
      'https://api.maptiler.com/maps/dataviz-v4/style.json?key=EAB6uPDrtlRzXsFngjM4'

    mapStyleUrlRef.current = mapStyleUrl

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

      // Separate source for an optional "veins" overlay that displays all
      // owned hexes as polygons, independent of the main frontier
      // rendering. This is populated by a React effect when showVeins is
      // toggled on.
      const emptyOwnedCollection = {
        type: 'FeatureCollection' as const,
        features: [] as {
          type: 'Feature'
          properties: { h3Index: string }
          geometry: { type: 'Polygon'; coordinates: [number, number][][] }
        }[],
      }

      map.addSource('owned-veins', {
        type: 'geojson',
        data: emptyOwnedCollection,
      })

      map.addSource('user-location', {
        type: 'geojson',
        data: { type: 'FeatureCollection' as const, features: [] as any[] },
      })

      map.addSource('user-accuracy', {
        type: 'geojson',
        data: { type: 'FeatureCollection' as const, features: [] as any[] },
      })

      map.addSource('user-heading', {
        type: 'geojson',
        data: { type: 'FeatureCollection' as const, features: [] as any[] },
      })

      map.addLayer({
        id: 'user-accuracy-fill',
        type: 'fill',
        source: 'user-accuracy',
        paint: {
          'fill-color': '#3b82f6',
          'fill-opacity': 0.12,
        },
      })

      map.addLayer({
        id: 'user-accuracy-outline',
        type: 'line',
        source: 'user-accuracy',
        paint: {
          'line-color': '#60a5fa',
          'line-width': 2,
          'line-opacity': 0.5,
        },
      })

      map.addLayer({
        id: 'user-heading-cone',
        type: 'fill',
        source: 'user-heading',
        paint: {
          'fill-color': '#3b82f6',
          'fill-opacity': 0.14,
        },
      })

      map.addLayer({
        id: 'user-location-dot-outline',
        type: 'circle',
        source: 'user-location',
        paint: {
          'circle-radius': 9,
          'circle-color': '#ffffff',
          'circle-opacity': 0.95,
        },
      })

      map.addLayer({
        id: 'user-location-dot',
        type: 'circle',
        source: 'user-location',
        paint: {
          'circle-radius': 6,
          'circle-color': '#3b82f6',
          'circle-opacity': 0.95,
        },
      })

      const pendingCoords = lastGeoCoordsRef.current
      if (pendingCoords) {
        setMapUserLocation(pendingCoords)
      }

      // If the user manually drags the map, disable follow mode so the UI
      // does not fight user input.
      map.on('dragstart', () => {
        setFollowMyLocation(false)
      })

      const loadOwnedHexes = async () => {
        if (!authToken) {
          ownedHexesRef.current = new Set()
          return
        }
        try {
          const res = await authedFetch(`${apiBase}/api/owned-hexes`)
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
        // If this map instance is no longer the active one (for example,
        // after we reinitialised the map when switching tabs), abort.
        if (map !== mapRef.current) {
          return
        }

        if (zoom < 14) {
          features = []
          featuresRef.current = []
          const emptyCollection = {
            type: 'FeatureCollection' as const,
            features: [] as HexFeature[],
          }
          try {
            const existing = map.getSource('h3-hex') as maplibregl.GeoJSONSource | undefined
            if (existing) {
              existing.setData(emptyCollection)
            }
          } catch {
            // If the map style has been destroyed (e.g. old instance), just
            // ignore; a fresh map instance will set up its own source.
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
          }

          const isOwned = ownedSet.has(hexIndex)
          const neighbors = h3.gridDisk(hexIndex, 1)
          const canMine = !isOwned && neighbors.some((n) => ownedSet.has(n))

          newFeatures.push({
            type: 'Feature',
            properties: {
              h3Index: hexIndex,
              zoneType,
              claimed: isOwned,
              selected: false,
              canMine,
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

        try {
          const existing = map.getSource('h3-hex') as maplibregl.GeoJSONSource | undefined
          if (existing) {
            existing.setData(featureCollection)
          }
        } catch {
          // Map style may have been torn down if this is a stale map
          // instance. In that case we simply skip; the new instance will load
          // its own data.
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
          // Frontier visualisation: claimed hexes are highlighted, directly
          // mineable neighbours are shown as faint candidates, everything else
          // is almost transparent.
          'fill-color': [
            'case',
            ['get', 'claimed'],
            '#b91c1c',
            ['get', 'selected'],
            '#ff9900',
            ['get', 'canMine'],
            '#e5e7eb',
            '#000000',
          ],
          'fill-opacity': [
            'case',
            ['get', 'claimed'],
            0.65,
            ['get', 'canMine'],
            0.15,
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

      // Veins overlay: soft red polygons for all owned hexes.
      map.addLayer({
        id: 'owned-veins-layer',
        type: 'fill',
        source: 'owned-veins',
        layout: {
          visibility: 'none',
        },
        paint: {
          'fill-color': '#b91c1c',
          'fill-opacity': 0.35,
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
        setCanSpawnHere(false)

        const ownedSet = ownedHexesRef.current
        const isOwned = ownedSet.has(h3Index)
        setSelectedOwned(isOwned)

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

        // If Drive Mode is active, interpret this click as a "drive step". The
        // first click in Drive Mode just seeds lastDriveHex; subsequent clicks
        // call the backend /api/drive/step endpoint to mine road hexes along
        // the corridor between the previous and current hexes.
        if (driveModeActiveRef.current) {
          const currentLastDriveHex = lastDriveHexRef.current

          if (!currentLastDriveHex) {
            // Start of a drive sequence.
            lastDriveHexRef.current = h3Index
            setToastMessage('Drive Mode: starting from this hex. Click another road hex to continue.')
            setToastType('success')
            return
          }

          const fromH3 = currentLastDriveHex
          const toH3 = h3Index

          try {
            const res = await authedFetch(`${apiBase}/api/drive/step`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ fromH3, toH3 }),
            })

            if (!res.ok) {
              if (res.status === 401) {
                setToastMessage('Please log in to use Drive Mode.')
              } else {
                setToastMessage('Drive step failed due to a server error.')
              }
              setToastType('error')
              return
            }

            const data: {
              ok?: boolean
              reason?: string
              minedHexes?: string[]
              count?: number
              grossReward?: number
              fee?: number
              netDelta?: number
              newBalance?: number
            } = await res.json()

            if (!data.ok) {
              if (data.reason === 'NO_ROAD_HEXES') {
                setToastMessage('Drive step: no road hexes found between these points.')
              } else if (data.reason === 'SAME_HEX') {
                setToastMessage('Drive step: choose a different target hex.')
              } else {
                setToastMessage('Drive step was not accepted.')
              }
              setToastType('error')
              if (typeof data.newBalance === 'number') {
                setUserBalance(data.newBalance)
              }
              return
            }

            if (typeof data.newBalance === 'number') {
              setUserBalance(data.newBalance)
            }

            const mined = Array.isArray(data.minedHexes) ? data.minedHexes : []
            if (mined.length > 0) {
              const ownedSetInner = ownedHexesRef.current
              for (const idx of mined) {
                ownedSetInner.add(idx)
              }

              const current = featuresRef.current
              if (current && current.length > 0) {
                const updated: HexFeature[] = current.map((f) => {
                  const idx = f.properties.h3Index
                  const isOwnedHex = ownedSetInner.has(idx)
                  const neighbors = h3.gridDisk(idx, 1)
                  const canMineNeighbor = !isOwnedHex && neighbors.some((n) => ownedSetInner.has(n))

                  return {
                    ...f,
                    properties: {
                      ...f.properties,
                      claimed: isOwnedHex,
                      canMine: canMineNeighbor,
                    },
                  }
                })

                featuresRef.current = updated

                const collection = {
                  type: 'FeatureCollection' as const,
                  features: updated,
                }

                const src = map.getSource('h3-hex') as maplibregl.GeoJSONSource | undefined
                if (src) {
                  src.setData(collection)
                }
              }

              if (typeof data.count === 'number') {
                setOwnedCount((prev) =>
                  typeof prev === 'number' ? prev + data.count! : data.count!,
                )
              }
            }

            const count = data.count ?? 0
            const fee = data.fee ?? 0
            const net = data.netDelta ?? count - fee
            setToastMessage(
              `Drive step successful: mined ${count} road hexes, fee ${fee} GHX, net +${net} GHX.`,
            )
            setToastType('success')

            lastDriveHexRef.current = h3Index
          } catch {
            setToastMessage('Drive step failed due to a network error.')
            setToastType('error')
          }
        }
      })
    })

    return () => {
      map.remove()
      mapRef.current = null
    }
  }, [apiBase, mapInstanceSeed])

  // When switching back to the MAP view from another tab, bump the
  // mapInstanceSeed so that the map initialisation effect runs again and the
  // previous MapLibre instance is cleaned up via its standard cleanup logic.
  // We intentionally avoid calling map.remove() directly here to prevent
  // double-destroy errors inside MapLibre if React triggers multiple effect
  // cycles.
  useEffect(() => {
    if (viewMode !== 'MAP') return

    setMapInstanceSeed((prev) => prev + 1)
  }, [viewMode])

  // Load combined account + wallet summary when the Account tab is opened.
  useEffect(() => {
    if (viewMode !== 'ACCOUNT') return
    if (!authToken) {
      setAccountInfo(null)
      setAccountError('Please log in to view your account.')
      setAccountLoading(false)
      return
    }

    const loadAccount = async () => {
      setAccountLoading(true)
      setAccountError(null)
      try {
        const res = await authedFetch(`${apiBase}/api/me`)
        if (!res.ok) {
          if (res.status === 401) {
            setAccountInfo(null)
            setAccountError('Please log in to view your account.')
          } else {
            setAccountError('Failed to load account information.')
          }
          setAccountLoading(false)
          return
        }

        const data: Partial<AccountInfo> = await res.json()
        if (
          typeof data.id === 'string' &&
          typeof data.ghxBalance === 'number' &&
          typeof data.usdtBalance === 'number' &&
          typeof data.ownedCount === 'number' &&
          Array.isArray(data.ownedHexes)
        ) {
          setAccountInfo({
            id: data.id,
            ghxBalance: data.ghxBalance,
            usdtBalance: data.usdtBalance,
            ownedCount: data.ownedCount,
            ownedHexes: data.ownedHexes,
          })
        } else {
          setAccountError('Account response was incomplete.')
        }
      } catch {
        setAccountError('Network error while loading account.')
      } finally {
        setAccountLoading(false)
      }
    }

    void loadAccount()
  }, [apiBase, viewMode, authToken])

  // Keep a simple resize in place when viewMode changes and a map instance is
  // already present (e.g. initial transition after mount). The more aggressive
  // teardown/recreate logic above handles the tricky cases.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    try {
      map.resize()
    } catch {
      // ignore resize errors
    }
  }, [viewMode])

  // Load demo user balance on mount
  useEffect(() => {
    const loadUser = async () => {
      if (!authToken) {
        setUserBalance(null)
        setOwnedCount(null)
        return
      }
      try {
        const res = await authedFetch(`${apiBase}/api/user`)
        if (res.ok) {
          const data: { balance?: number; ownedCount?: number } = await res.json()
          if (typeof data.balance === 'number') {
            setUserBalance(data.balance)
          }
          if (typeof data.ownedCount === 'number') {
            setOwnedCount(data.ownedCount)
          }
        } else if (res.status === 401) {
          setUserBalance(null)
          setOwnedCount(null)
        }
      } catch {
        // ignore load errors for now
      }
    }

    void loadUser()
  }, [apiBase, authToken])

  useEffect(() => {
    if (!authToken) {
      setUsdtBalance(null)
      return
    }

    const loadBalances = async () => {
      try {
        const res = await authedFetch(`${apiBase}/api/market/balance`)
        if (!res.ok) {
          if (res.status === 401) {
            setUsdtBalance(null)
          }
          return
        }
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
        const data: {
          lastPrice: number | null
          volume24h?: number
          trades?: number
          vwap24h?: number | null
          change24h?: number | null
        } = await res.json()
        setLastPrice(data.lastPrice)
        if (typeof data.volume24h === 'number') {
          setVolume24h(data.volume24h)
        }
        if (typeof data.trades === 'number') {
          setTradeCount24h(data.trades)
        }
        if (typeof data.vwap24h === 'number') {
          setVwap24h(data.vwap24h)
        } else {
          setVwap24h(null)
        }
        if (typeof data.change24h === 'number') {
          setChange24h(data.change24h)
        } else {
          setChange24h(null)
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
  }, [apiBase, authToken])

  // Veins overlay: when toggled on, populate the dedicated MapLibre source
  // with all owned hexes as polygon features, and show the fill layer. When
  // toggled off, hide the layer. This is intentionally decoupled from the main
  // frontier rendering to avoid extra work on every viewport change.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    const source = map.getSource('owned-veins') as maplibregl.GeoJSONSource | undefined
    const layerId = 'owned-veins-layer'

    if (!source) return

    if (!showVeins) {
      // Hide the layer when the overlay is turned off.
      if (map.getLayer(layerId)) {
        map.setLayoutProperty(layerId, 'visibility', 'none')
      }
      return
    }

    const ownedSet = ownedHexesRef.current

    const features = Array.from(ownedSet).map((idx) => {
      const boundary = h3.cellToBoundary(idx, true)
      const coords = boundary.map(([lat, lng]) => [lng, lat] as [number, number])
      // Close the polygon ring
      if (coords.length > 0) {
        coords.push(coords[0])
      }

      return {
        type: 'Feature' as const,
        properties: { h3Index: idx },
        geometry: {
          type: 'Polygon' as const,
          coordinates: [coords],
        },
      }
    })

    const collection = {
      type: 'FeatureCollection' as const,
      features,
    }

    source.setData(collection)

    if (map.getLayer(layerId)) {
      map.setLayoutProperty(layerId, 'visibility', 'visible')
    }
  }, [showVeins])

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

    const { h3Index } = selectedHex

    const doMine = async () => {
      try {
        const res = await authedFetch(`${apiBase}/api/mine`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ h3Index }),
        })

        if (!res.ok) {
          if (res.status === 401) {
            setMineMessage('Please log in to mine hexes.')
          } else {
            setMineMessage('Mining failed due to a server error.')
          }
          setMineMessageType('error')
          return
        }

        const data: { ok?: boolean; balance?: number; reason?: string; zoneType?: ZoneType } =
          await res.json()

        setCanSpawnHere(false)

        if (!data.ok) {
          if (data.reason === 'ALREADY_MINED') {
            setMineMessage('This hex has already been mined for this user.')
          } else if (data.reason === 'NOT_ADJACENT') {
            setMineMessage('You can only mine hexes that touch an already mined hex.')
            setCanSpawnHere(true)
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

        // After a successful mine, refresh user info from the backend so that
        // both balance and owned hex count are fully in sync with the server.
        try {
          const userRes = await authedFetch(`${apiBase}/api/user`)
          if (userRes.ok) {
            const userData: { balance?: number; ownedCount?: number } = await userRes.json()
            if (typeof userData.balance === 'number') {
              setUserBalance(userData.balance)
            }
            if (typeof userData.ownedCount === 'number') {
              setOwnedCount(userData.ownedCount)
            }
          }
        } catch {
          // ignore user refresh errors; we still have the optimistic update above
        }

        setSelectedOwned(true)

        ownedHexesRef.current.add(h3Index)

        const currentFeatures = featuresRef.current
        if (!currentFeatures || currentFeatures.length === 0 || !mapRef.current) {
          setMineMessage(`Hex ${h3Index} mined, but map state could not be updated.`)
          setMineMessageType('error')
          return
        }

        const ownedSet = ownedHexesRef.current
        const updatedFeatures: HexFeature[] = currentFeatures.map((f) => {
          const idx = f.properties.h3Index
          const isOwned = ownedSet.has(idx)
          const neighbors = h3.gridDisk(idx, 1)
          const canMine = !isOwned && neighbors.some((n) => ownedSet.has(n))

          return {
            ...f,
            properties: {
              ...f.properties,
              claimed: isOwned,
              canMine,
            },
          }
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

  const handleDriveSimulateClick = () => {
    const map = mapRef.current
    if (!map) return

    // Prefer to use the currently selected hex as the centre for Drive Mode,
    // so that the effect feels local to the road segment שהשחקן רואה. If no
    // hex is selected, fall back to the map centre H3 index.
    let centerH3Index: string | null = null

    if (selectedHex) {
      centerH3Index = selectedHex.h3Index
    } else {
      const center = map.getCenter()

      // Use the same H3 resolution as the map grid for Drive Mode simulation.
      const h3Resolution = 11
      try {
        centerH3Index = h3.latLngToCell(center.lat, center.lng, h3Resolution)
      } catch {
        setToastMessage('Drive mining failed: could not compute centre hex.')
        setToastType('error')
        return
      }
    }

    if (!centerH3Index) {
      setToastMessage('Drive mining failed: no valid centre hex.')
      setToastType('error')
      return
    }

    const doSimulate = async () => {
      try {
        const res = await authedFetch(`${apiBase}/api/drive/simulate`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ centerH3Index }),
        })

        if (!res.ok) {
          if (res.status === 401) {
            setToastMessage('Please log in to use Drive Mode.')
          } else {
            setToastMessage('Drive Mode simulation failed due to a server error.')
          }
          setToastType('error')
          return
        }

        const data: {
          ok?: boolean
          reason?: string
          addedHexes?: number
          ghxCost?: number
          newBalance?: number
          claimedHexes?: string[]
        } = await res.json()

        if (!data.ok) {
          if (data.reason === 'INSUFFICIENT_GHX') {
            setToastMessage('Not enough GHX to run Drive Mode here.')
          } else if (data.reason === 'NO_ROAD_HEXES') {
            setToastMessage('No main road hexes found near the map centre.')
          } else {
            setToastMessage('Drive mining was not accepted.')
          }
          setToastType('error')
          if (typeof data.newBalance === 'number') {
            setUserBalance(data.newBalance)
          }
          return
        }

        if (typeof data.newBalance === 'number') {
          setUserBalance(data.newBalance)
        }

        if (typeof data.addedHexes === 'number') {
          setOwnedCount((prev) => (typeof prev === 'number' ? prev + data.addedHexes! : data.addedHexes!))
        }

        if (Array.isArray(data.claimedHexes) && data.claimedHexes.length > 0) {
          const ownedSet = ownedHexesRef.current
          for (const idx of data.claimedHexes) {
            ownedSet.add(idx)
          }

          const currentFeatures = featuresRef.current
          if (currentFeatures && currentFeatures.length > 0) {
            const updatedFeatures: HexFeature[] = currentFeatures.map((f) => {
              const idx = f.properties.h3Index
              const isOwned = ownedSet.has(idx)
              const neighbors = h3.gridDisk(idx, 1)
              const canMine = !isOwned && neighbors.some((n) => ownedSet.has(n))

              return {
                ...f,
                properties: {
                  ...f.properties,
                  claimed: isOwned,
                  canMine,
                },
              }
            })

            featuresRef.current = updatedFeatures

            const updatedCollection = {
              type: 'FeatureCollection' as const,
              features: updatedFeatures,
            }

            const src = map.getSource('h3-hex') as maplibregl.GeoJSONSource | undefined
            if (src) {
              src.setData(updatedCollection)
            }
          }
        }

        const added = data.addedHexes ?? 0
        const cost = data.ghxCost ?? 0
        setToastMessage(`Drive mining successful: claimed ${added} road hexes for ${cost} GHX.`)
        setToastType('success')
      } catch {
        setToastMessage('Drive mining failed due to a network error.')
        setToastType('error')
      }
    }

    void doSimulate()
  }

  const handleSpawnClick = () => {
    if (!selectedHex) {
      return
    }

    const { h3Index } = selectedHex

    const doSpawn = async () => {
      try {
        const res = await authedFetch(`${apiBase}/api/spawn`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ h3Index }),
        })

        if (!res.ok) {
          if (res.status === 401) {
            setMineMessage('Please log in to spawn new mining areas.')
          } else {
            setMineMessage('Spawn failed due to a server error.')
          }
          setMineMessageType('error')
          return
        }

        const data: { ok?: boolean; balance?: number; reason?: string; spawnCost?: number } =
          await res.json()

        if (!data.ok) {
          if (data.reason === 'ALREADY_OWNED') {
            setMineMessage('You already own this hex.')
          } else if (data.reason === 'INSUFFICIENT_GHX') {
            setMineMessage('You do not have enough GHX to start a new mining area here.')
          } else {
            setMineMessage('Spawn was not accepted.')
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

        // Refresh user info so owned hex count stays in sync.
        try {
          const userRes = await authedFetch(`${apiBase}/api/user`)
          if (userRes.ok) {
            const userData: { balance?: number; ownedCount?: number } = await userRes.json()
            if (typeof userData.balance === 'number') {
              setUserBalance(userData.balance)
            }
            if (typeof userData.ownedCount === 'number') {
              setOwnedCount(userData.ownedCount)
            }
          }
        } catch {
          // ignore user refresh errors
        }

        setSelectedOwned(true)
        setCanSpawnHere(false)

        ownedHexesRef.current.add(h3Index)

        const currentFeatures = featuresRef.current
        if (!currentFeatures || currentFeatures.length === 0 || !mapRef.current) {
          setMineMessage(`Spawned at ${h3Index}, but map state could not be updated.`)
          setMineMessageType('error')
          return
        }

        const ownedSet = ownedHexesRef.current
        const updatedFeatures: HexFeature[] = currentFeatures.map((f) => {
          const idx = f.properties.h3Index
          const isOwned = ownedSet.has(idx)
          const neighbors = h3.gridDisk(idx, 1)
          const canMine = !isOwned && neighbors.some((n) => ownedSet.has(n))

          return {
            ...f,
            properties: {
              ...f.properties,
              claimed: isOwned,
              canMine,
            },
          }
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

        setMineMessage(`Started a new mining area here (spawn successful).`)
        setMineMessageType('success')
      } catch {
        setMineMessage('Spawn failed due to a network error.')
        setMineMessageType('error')
      }
    }

    void doSpawn()
  }

  const handleCloseInfoPanel = () => {
    setSelectedInfo(null)
    setSelectedHex(null)
    setSelectedDebug(null)
    setSelectedOwned(null)
    setMineMessage(null)
    setMineMessageType(null)
    setCanSpawnHere(false)
  }

  const handleUseMyLocationClick = () => {
    if (!navigator.geolocation) {
      // Browser does not support geolocation
      setToastMessage('Geolocation is not supported by this browser.')
      setToastType('error')
      return
    }

    setFollowMyLocation(true)

    if (geoWatchIdRef.current === null) {
      geoWatchIdRef.current = navigator.geolocation.watchPosition(
        (pos) => {
          const heading =
            typeof pos.coords.heading === 'number' && Number.isFinite(pos.coords.heading)
              ? pos.coords.heading
              : null
          setMapUserLocation({
            lon: pos.coords.longitude,
            lat: pos.coords.latitude,
            accuracyM: typeof pos.coords.accuracy === 'number' ? pos.coords.accuracy : 30,
            headingDeg: heading,
          })
        },
        (error) => {
          setToastMessage(error.message || 'Failed to get current location.')
          setToastType('error')
        },
        { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 },
      )
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

  const handleViewHexOnMapFromAccount = (h3Index: string) => {
    const map = mapRef.current
    if (!map) return

    try {
      const [lat, lng] = h3.cellToLatLng(h3Index)
      map.flyTo({ center: [lng, lat], zoom: 14 })
    } catch {
      // ignore invalid h3 index
    }
  }

  const handleOrderSubmit = async () => {
    if (!orderPrice || !orderAmount) {
      setOrderError('Please enter both price and amount.')
      return
    }

    const price = Number(orderPrice)
    const amount = Number(orderAmount)

    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(amount) || amount <= 0) {
      setOrderError('Please enter a valid positive price and amount.')
      return
    }

    setOrderSubmitting(true)
    try {
      const res = await authedFetch(`${apiBase}/api/market/order`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          side: orderSide,
          price,
          amount,
        }),
      })

      type MarketTrade = {
        id: string
        pair: 'GHX-USDT'
        side: 'BUY' | 'SELL'
        price: number
        amount: number
        timestamp: number
      }

      const data: {
        ok?: boolean
        error?: string
        trade?: MarketTrade
        balances?: { ghx?: number; usdt?: number }
      } = await res.json()

      if (!res.ok || !data.ok) {
        if (res.status === 401) {
          setOrderError('Please log in to place orders.')
        } else {
          setOrderError(data.error ?? 'Order failed.')
        }
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
        const trade = data.trade
        setLastPrice(trade.price)
        setRecentTrades((prev) => [trade, ...prev].slice(0, 100))
      }

      setOrderPrice('')
      setOrderAmount('')
    } catch {
      setOrderError('Order failed due to a network error.')
    } finally {
      setOrderSubmitting(false)
    }
  }

  return (
    <div className="app-root">
      <div className="top-bar">
        <div className="top-bar-title">
          <img
            src="/ghx-logo.svg"
            alt="GHX logo"
            style={{ width: 28, height: 28, marginRight: 8, verticalAlign: 'middle' }}
          />
          GeoHex Miner
        </div>
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
          <button
            type="button"
            className={viewMode === 'POLICY' ? 'top-bar-tab top-bar-tab-active' : 'top-bar-tab'}
            onClick={() => setViewMode('POLICY')}
          >
            Policy
          </button>
          <button
            type="button"
            className={viewMode === 'ACCOUNT' ? 'top-bar-tab top-bar-tab-active' : 'top-bar-tab'}
            onClick={() => setViewMode('ACCOUNT')}
          >
            Account
          </button>
        </div>
      </div>
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

      {viewMode === 'MAP' && (
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
          <div className="hud-line">
            <button
              type="button"
              className="drive-button"
              onClick={handleDriveSimulateClick}
              disabled={typeof userBalance === 'number' && userBalance < 5}
            >
              Simulate Drive Mode mining near map centre (5 GHX)
            </button>
          </div>
          <div className="hud-line">
            <button
              type="button"
              className={driveModeActive ? 'drive-toggle drive-toggle-active' : 'drive-toggle'}
              onClick={handleToggleDriveMode}
            >
              {driveModeActive ? 'Drive Mode: ON (click hexes to drive)' : 'Drive Mode: OFF'}
            </button>
          </div>
          <div className="hud-line">
            <button
              type="button"
              className={showVeins ? 'veins-toggle veins-toggle-active' : 'veins-toggle'}
              onClick={() => setShowVeins((prev) => !prev)}
            >
              {showVeins ? 'Hide mined veins overlay' : 'Show mined veins overlay'}
            </button>
          </div>
        </div>
      )}
      {viewMode === 'ACCOUNT' && (
        <div className="account-panel">
          <div className="account-header">Account &amp; Wallet</div>
          <div className="account-content">
            {!authToken && (
              <div className="account-section">
                <div className="account-section-title">Login / Register</div>
                <div className="account-row">
                  <span className="account-label">Email:</span>
                  <input
                    value={authEmail}
                    onChange={(e) => setAuthEmail(e.target.value)}
                    className="account-input"
                    placeholder="you@example.com"
                  />
                </div>
                <div className="account-row">
                  <span className="account-label">Password:</span>
                  <input
                    value={authPassword}
                    onChange={(e) => setAuthPassword(e.target.value)}
                    className="account-input"
                    type="password"
                    placeholder="Minimum 6 characters"
                  />
                </div>
                <div className="account-row">
                  <button
                    type="button"
                    className="account-action"
                    onClick={handleAuthLogin}
                    disabled={authSubmitting}
                  >
                    Login
                  </button>
                  <button
                    type="button"
                    className="account-action"
                    onClick={handleAuthRegister}
                    disabled={authSubmitting}
                    style={{ marginLeft: 8 }}
                  >
                    Register
                  </button>
                </div>
                {authError && <div className="account-row account-error">{authError}</div>}
              </div>
            )}
            {authToken && (
              <div className="account-section">
                <div className="account-section-title">Session</div>
                <div className="account-row">
                  <button type="button" className="account-action" onClick={handleLogout}>
                    Logout
                  </button>
                </div>
              </div>
            )}
            {accountLoading && <div className="account-row">Loading account…</div>}
            {accountError && !accountLoading && (
              <div className="account-row account-error">{accountError}</div>
            )}
            {!accountLoading && !accountError && accountInfo && (
              <>
                <div className="account-section">
                  <div className="account-section-title">User</div>
                  <div className="account-row">
                    <span className="account-label">User ID:</span>
                    <span className="account-value">{accountInfo.id}</span>
                  </div>
                </div>

                <div className="account-section">
                  <div className="account-section-title">Wallet summary</div>
                  <div className="account-row">
                    <span className="account-label">GHX balance:</span>
                    <span className="account-value">{accountInfo.ghxBalance}</span>
                  </div>
                  <div className="account-row">
                    <span className="account-label">USDT balance:</span>
                    <span className="account-value">{accountInfo.usdtBalance}</span>
                  </div>
                  <div className="account-row">
                    <span className="account-label">Owned hexes:</span>
                    <span className="account-value">{accountInfo.ownedCount}</span>
                  </div>
                </div>

                <div className="account-section">
                  <div className="account-section-title">My hexes</div>
                  {accountInfo.ownedHexes.length === 0 && (
                    <div className="account-row">You do not own any hexes yet.</div>
                  )}
                  {accountInfo.ownedHexes.length > 0 && (
                    <div className="account-hex-list">
                      {accountInfo.ownedHexes.map((hex) => (
                        <div key={hex} className="account-hex-row">
                          <span className="account-hex-id">{hex}</span>
                          <button
                            type="button"
                            className="account-hex-button"
                            onClick={() => handleViewHexOnMapFromAccount(hex)}
                          >
                            View on map
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="account-section">
                  <div className="account-section-title">Notes</div>
                  <p className="account-notes">
                    Your hex ownership and GHX balance are currently stored as in-game assets for this
                    demo user. They are not real-world money, not a bank account and not a crypto
                    wallet. Future versions of GeoHex Miner may introduce optional migration paths
                    towards external wallets or tokens, but there is no promise of value or
                    convertibility at this stage.
                  </p>
                </div>
              </>
            )}
          </div>
        </div>
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
              <div className="trade-ticker-line">
                <span className="trade-ticker-label">24h VWAP:</span>
                <span className="trade-ticker-value">
                  {vwap24h != null ? `${vwap24h.toFixed(4)} USDT` : '-'}
                </span>
              </div>
              <div className="trade-ticker-line">
                <span className="trade-ticker-label">24h change:</span>
                <span
                  className="trade-ticker-value"
                  style={{
                    color:
                      change24h == null
                        ? undefined
                        : change24h > 0
                          ? '#22c55e'
                          : change24h < 0
                            ? '#f97316'
                            : '#e5e7eb',
                  }}
                >
                  {change24h != null ? `${change24h >= 0 ? '+' : ''}${change24h.toFixed(2)}%` : '-'}
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
                onClick={handleOrderSubmit}
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

      {viewMode === 'POLICY' && (
        <div className="policy-panel">
          <div className="policy-header">GeoHex Mining &amp; Safety Policy</div>
          <div className="policy-scroll">
            <p className="policy-text">
              GeoHex Miner is a location-based game. Mining GHX depends on your real-world position,
              the type of terrain you are in, and your movement. Safety and compliance with local
              law always come before gameplay.
            </p>
            <h3 className="policy-section-title">1. Core principles</h3>
            <ul className="policy-list">
              <li>
                <strong>Reality-based supply:</strong> The availability and difficulty of mining GHX
                are determined by real-world geography (roads, settlements, wilderness and water
                areas).
              </li>
              <li>
                <strong>Safety first:</strong> Never use the app in a way that distracts you from
                driving, walking safely, or being aware of your surroundings.
              </li>
              <li>
                <strong>User responsibility:</strong> You are solely responsible for obeying traffic
                rules, access restrictions and any applicable law where you play.
              </li>
            </ul>
            <h3 className="policy-section-title">2. Mining by zone type</h3>
            <p className="policy-text">
              The app classifies hexes into different zone types using map data. Mining rules depend
              on this classification and on your speed:
            </p>
            <ul className="policy-list">
              <li>
                <strong>Road zones:</strong> A hex is treated as a road hex if any part of it touches
                a mapped road. Automatic mining while driving may be allowed in these hexes, subject
                to speed and safety limits. Manual tapping while driving is restricted.
              </li>
              <li>
                <strong>Urban / settlement zones:</strong> Cities, towns, villages and other built-up
                areas. Manual mining via the mine button is allowed at low and normal speeds, subject
                to safety rules.
              </li>
              <li>
                <strong>Rural / wilderness zones:</strong> Farmland, forests, deserts, mountains and
                other non-urban land, including areas that are far from roads. Mining here is manual
                only and may require you to move slowly or be on foot.
              </li>
              <li>
                <strong>Marine zones:</strong> Oceans, seas and large lakes. Mining, if enabled, is
                limited to safe boating speeds and may be further restricted in ports, protected
                areas or other sensitive locations.
              </li>
              <li>
                <strong>Restricted zones:</strong> Military areas, hospitals, dangerous cliffs and
                similar locations are not mineable for safety and legal reasons.
              </li>
            </ul>
            <h3 className="policy-section-title">3. Speed and high-risk activities</h3>
            <ul className="policy-list">
              <li>
                Do not actively play GeoHex Miner while driving or operating any vehicle. Where
                possible, the app will block manual actions at higher speeds, but you must still
                follow the law and use your judgement.
              </li>
              <li>
                Mining is blocked in flight and may be limited at extremely high speeds (for example
                in fast trains or high-speed vehicles).
              </li>
              <li>
                Always stop in a safe place before looking at the screen or interacting with the
                app.
              </li>
            </ul>
            <h3 className="policy-section-title">4. Obeying laws and respecting property</h3>
            <ul className="policy-list">
              <li>
                Obey all traffic rules, local laws and signs. Do not trespass on private property or
                enter closed or dangerous areas in order to mine a hex.
              </li>
              <li>
                Protected areas (such as military zones or certain nature reserves) may be blocked or
                limited in the game regardless of their physical accessibility.
              </li>
            </ul>
            <h3 className="policy-section-title">5. Natural scarcity and game economy</h3>
            <p className="policy-text">
              The global supply of GHX is tied to the finite number of hexes on Earth. Easy-to-access
              urban and road-adjacent hexes are likely to be mined first. Over time, remaining supply
              will naturally shift to harder-to-reach areas such as wilderness and open water. This
              progression is driven by real-world geography and effort, not by arbitrary reward
              changes.
            </p>
            <h3 className="policy-section-title">6. Limitation of liability</h3>
            <p className="policy-text">
              GeoHex Miner is provided as-is. The operators are not responsible for any injury,
              damage or legal consequence resulting from unsafe or unlawful use of the app. By using
              GeoHex Miner you agree to play responsibly and at your own risk.
            </p>
          </div>
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
          onClick={() => {
            setToastMessage(null)
            setToastType(null)
          }}
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
          {selectedHex && canSpawnHere && (
            <button type="button" className="mine-button" onClick={handleSpawnClick}>
              Start a new mining area here (Spawn for 5 GHX)
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
