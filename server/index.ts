import express from 'express'
import cors from 'cors'
import * as h3 from 'h3-js'
import fetch from 'node-fetch'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()
const port = Number(process.env.PORT) || 4000

app.use(cors())
app.use(express.json())

// Very simple user + wallet model for demo purposes.
// In a real system you'd use a proper database and real authentication.
type User = {
  id: string
  balance: number
  ownedHexes: Set<string>
}

type StoredUser = {
  id: string
  balance: number
  ownedHexes: string[]
}

const dataDir = path.join(__dirname, '..', 'data')
const userDataPath = path.join(dataDir, 'demoUser.json')
const hexCachePath = path.join(dataDir, 'hexCache.json')
const tradesDataPath = path.join(dataDir, 'marketTrades.json')
const miningEventsPath = path.join(dataDir, 'miningEvents.json')

function loadDemoUser(): User {
  try {
    if (!fs.existsSync(userDataPath)) {
      return {
        id: 'demo-user',
        balance: 0,
        ownedHexes: new Set<string>(),
      }
    }

    const raw = fs.readFileSync(userDataPath, 'utf8')
    const stored = JSON.parse(raw) as StoredUser

    return {
      id: stored.id ?? 'demo-user',
      balance: typeof stored.balance === 'number' ? stored.balance : 0,
      ownedHexes: new Set<string>(Array.isArray(stored.ownedHexes) ? stored.ownedHexes : []),
    }
  } catch {
    return {
      id: 'demo-user',
      balance: 0,
      ownedHexes: new Set<string>(),
    }
  }
}

function saveDemoUser(user: User): void {
  try {
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true })
    }

    const stored: StoredUser = {
      id: user.id,
      balance: user.balance,
      ownedHexes: Array.from(user.ownedHexes),
    }

    fs.writeFileSync(userDataPath, JSON.stringify(stored, null, 2), 'utf8')
  } catch {
    // For demo purposes ignore persistence errors
  }
}

const demoUser: User = loadDemoUser()

type HexCacheEntry = {
  zoneType: ZoneType
  debug: string[]
}

function loadHexCache(): Record<string, HexCacheEntry> {
  try {
    if (!fs.existsSync(hexCachePath)) {
      return {}
    }

    const raw = fs.readFileSync(hexCachePath, 'utf8')
    const parsed = JSON.parse(raw) as Record<string, HexCacheEntry>
    if (parsed && typeof parsed === 'object') {
      return parsed
    }
  } catch {
    // ignore cache load errors and start with empty cache
  }

  return {}
}

function saveHexCache(cache: Record<string, HexCacheEntry>): void {
  try {
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true })
    }

    fs.writeFileSync(hexCachePath, JSON.stringify(cache, null, 2), 'utf8')
  } catch {
    // ignore cache save errors for demo purposes
  }
}

const hexCache: Record<string, HexCacheEntry> = loadHexCache()

type MiningEvent = {
  timestamp: number
  h3Index: string
}

function loadMiningEvents(): MiningEvent[] {
  try {
    if (!fs.existsSync(miningEventsPath)) {
      return []
    }

    const raw = fs.readFileSync(miningEventsPath, 'utf8')
    const parsed = JSON.parse(raw) as MiningEvent[]
    if (Array.isArray(parsed)) {
      return parsed
    }
  } catch {
    // ignore
  }

  return []
}

function saveMiningEvents(events: MiningEvent[]): void {
  try {
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true })
    }

    fs.writeFileSync(miningEventsPath, JSON.stringify(events, null, 2), 'utf8')
  } catch {
    // ignore
  }
}

const miningEvents: MiningEvent[] = loadMiningEvents()

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

function fallbackZoneType(h3Index: string): ZoneType {
  const zoneTypes: ZoneType[] = ['SEA', 'MAIN_ROAD', 'URBAN', 'MILITARY', 'HOSPITAL', 'CLIFF', 'COAST']

  let hash = 0
  for (const ch of h3Index) {
    hash = (hash + ch.charCodeAt(0)) % 10000
  }
  return zoneTypes[hash % zoneTypes.length]
}

type OverpassElement = {
  type: string
  tags?: Record<string, string>
}

type InferredZone = {
  zoneType: ZoneType
  debug: string[]
}

async function inferZoneTypeFromOverpass(h3Index: string): Promise<InferredZone> {
  const boundary = h3.cellToBoundary(h3Index, true)

  const lats = boundary.map(([lat]) => lat)
  const lngs = boundary.map(([, lng]) => lng)
  const south = Math.min(...lats)
  const north = Math.max(...lats)
  const west = Math.min(...lngs)
  const east = Math.max(...lngs)

  const overpassQuery = `
    [out:json][timeout:10];
    (
      // Roads / traffic
      way["highway"](${south},${west},${north},${east});

      // Military / safety sensitive
      way["landuse"="military"](${south},${west},${north},${east});
      node["military"](${south},${west},${north},${east});

      // Hospitals
      node["amenity"="hospital"](${south},${west},${north},${east});
      way["amenity"="hospital"](${south},${west},${north},${east});

      // Nature reserves / forests / parks
      way["leisure"="nature_reserve"](${south},${west},${north},${east});
      relation["leisure"="nature_reserve"](${south},${west},${north},${east});
      way["boundary"="protected_area"](${south},${west},${north},${east});
      relation["boundary"="protected_area"](${south},${west},${north},${east});
      way["leisure"="park"](${south},${west},${north},${east});
      relation["leisure"="park"](${south},${west},${north},${east});
      way["landuse"="forest"](${south},${west},${north},${east});
      relation["landuse"="forest"](${south},${west},${north},${east});
      way["natural"="wood"](${south},${west},${north},${east});
      relation["natural"="wood"](${south},${west},${north},${east});

      // Rivers / streams / canals
      way["waterway"="river"](${south},${west},${north},${east});
      way["waterway"="stream"](${south},${west},${north},${east});
      way["waterway"="canal"](${south},${west},${north},${east});
      way["water"="river"](${south},${west},${north},${east});
      relation["water"="river"](${south},${west},${north},${east});

      // Sea / water detection – be generous here so that open-sea hexes
      // are reliably classified as SEA and not as URBAN.
      way["natural"="sea"](${south},${west},${north},${east});
      relation["natural"="sea"](${south},${west},${north},${east});
      way["natural"="water"](${south},${west},${north},${east});
      relation["natural"="water"](${south},${west},${north},${east});
      way["place"="sea"](${south},${west},${north},${east});
      relation["place"="sea"](${south},${west},${north},${east});
      way["water"](${south},${west},${north},${east});
      relation["water"](${south},${west},${north},${east});

      // Coastline / cliffs
      way["natural"="coastline"](${south},${west},${north},${east});
      way["natural"="cliff"](${south},${west},${north},${east});
    );
    out body;
  `

  const response = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain',
    },
    // Overpass expects the raw query string in the body
    body: overpassQuery,
  })

  if (!response.ok) {
    throw new Error(`Overpass error: ${response.status}`)
  }

  const data = (await response.json()) as { elements?: OverpassElement[] }
  const elements = data.elements ?? []

  let hasMilitary = false
  let hasHospital = false
  let hasSea = false
  let hasCoast = false
  let hasCliff = false
  let hasMainRoad = false
  let hasNature = false
  let hasRiver = false
  const debug: string[] = []

  for (const el of elements) {
    const tags = el.tags ?? {}

    if (tags.landuse === 'military' || tags.military) {
      hasMilitary = true
    }

    if (tags.amenity === 'hospital') {
      hasHospital = true
    }

    // Nature reserves / protected areas / forests / large parks
    if (
      tags.leisure === 'nature_reserve' ||
      tags.boundary === 'protected_area' ||
      tags.leisure === 'park' ||
      tags.landuse === 'forest' ||
      tags.natural === 'wood'
    ) {
      hasNature = true
    }

    if (tags.waterway === 'river' || tags.waterway === 'stream' || tags.waterway === 'canal' || tags.water === 'river') {
      hasRiver = true
    }

    if (tags.natural === 'sea' || tags.natural === 'water' || tags.water) {
      hasSea = true
    }

    if (tags.natural === 'coastline') {
      hasCoast = true
    }

    if (tags.natural === 'cliff') {
      hasCliff = true
    }

    if (tags.highway && ['motorway', 'trunk', 'primary', 'secondary'].includes(tags.highway)) {
      hasMainRoad = true
    }
  }

  // Priority order: sea (any open water) / military / hospital / main road / nature / river / coast / cliff / urban.
  // For gameplay purposes, as soon as we detect "sea/water" tags we treat the hex as SEA even if
  // other tags (roads, military etc.) also exist in the same Overpass window.
  if (hasSea) {
    debug.push('OSM: water/sea detected (forced SEA for gameplay)')
    return { zoneType: 'SEA', debug }
  }
  if (hasMilitary) {
    debug.push('OSM: military landuse detected')
    return { zoneType: 'MILITARY', debug }
  }
  if (hasHospital) {
    debug.push('OSM: hospital detected')
    return { zoneType: 'HOSPITAL', debug }
  }
  if (hasMainRoad) {
    debug.push('OSM: main road (motorway/trunk/primary/secondary) detected')
    return { zoneType: 'MAIN_ROAD', debug }
  }
  if (hasNature) {
    debug.push('OSM: nature reserve / forest / park detected')
    return { zoneType: 'NATURE_RESERVE', debug }
  }
  if (hasRiver) {
    debug.push('OSM: river / stream / canal detected')
    return { zoneType: 'RIVER', debug }
  }
  if (hasCoast) {
    debug.push('OSM: coastline detected')
    return { zoneType: 'COAST', debug }
  }
  if (hasCliff) {
    debug.push('OSM: cliff detected')
    return { zoneType: 'CLIFF', debug }
  }

  debug.push('OSM: no special tags found, defaulting to URBAN')
  return { zoneType: 'URBAN', debug }
}

// Endpoint used for initial map rendering – first tries cached OSM/Overpass-based
// classification, then falls back to a deterministic hash-based type on error.
app.get('/api/hex/:h3Index', async (req, res) => {
  const { h3Index } = req.params

  if (!h3Index || typeof h3Index !== 'string') {
    res.status(400).json({ error: 'INVALID_H3_INDEX' })
    return
  }

  let entry = hexCache[h3Index]

  if (!entry) {
    try {
      const inferred = await inferZoneTypeFromOverpass(h3Index)
      entry = {
        zoneType: inferred.zoneType,
        debug: inferred.debug,
      }
      hexCache[h3Index] = entry
      saveHexCache(hexCache)
    } catch (err) {
      const zoneType = fallbackZoneType(h3Index)
      const message = err instanceof Error ? err.message : String(err)
      entry = {
        zoneType,
        debug: [
          `Overpass failed in /api/hex: ${message}`,
          'Using hash-based zoneType fallback for this hex',
        ],
      }
      hexCache[h3Index] = entry
      saveHexCache(hexCache)
    }
  }

  const result = {
    h3Index,
    zoneType: entry.zoneType,
    debug: entry.debug,
  }

  res.json(result)
})

// Simple stats endpoint: returns mined GHX over time, bucketed by day
// (UTC date string) with daily and cumulative counts.
app.get('/api/stats/mined', (_req, res) => {
  const byDay = new Map<string, number>()

  for (const ev of miningEvents) {
    const date = new Date(ev.timestamp)
    const dayKey = date.toISOString().slice(0, 10) // YYYY-MM-DD in UTC
    byDay.set(dayKey, (byDay.get(dayKey) ?? 0) + 1)
  }

  const days = Array.from(byDay.keys()).sort()
  const points: { day: string; daily: number; cumulative: number }[] = []
  let cumulative = 0

  for (const day of days) {
    const daily = byDay.get(day) ?? 0
    cumulative += daily
    points.push({ day, daily, cumulative })
  }

  res.json({
    points,
    total: cumulative,
  })
})

// ---- Basic market API for GeoHex (GHX) trading against USDT ----

// Return balances for the demo user for GHX and USDT.
app.get('/api/market/balance', (_req, res) => {
  res.json({
    userId: demoUser.id,
    ghx: demoUser.balance,
    usdt: demoUserUsdtBalance,
  })
})

// Ticker endpoint for GHX-USDT – based on the last trade if available.
app.get('/api/market/ticker', (_req, res) => {
  const last = getLastTrade()

  if (!last) {
    res.json({
      pair: 'GHX-USDT',
      lastPrice: null,
      volume24h: 0,
      trades: 0,
    })
    return
  }

  const now = Date.now()
  const dayAgo = now - 24 * 60 * 60 * 1000
  let volume24h = 0
  let trades24h = 0

  for (const t of trades) {
    if (t.timestamp >= dayAgo) {
      volume24h += t.amount
      trades24h += 1
    }
  }

  res.json({
    pair: 'GHX-USDT',
    lastPrice: last.price,
    volume24h,
    trades: trades24h,
  })
})

// Very simple orderbook implementation: exposes the last N trades as a pseudo book.
// In later versions this can be replaced with a real limit order book.
app.get('/api/market/orderbook', (_req, res) => {
  const last = getLastTrade()
  const midPrice = last?.price ?? 1

  res.json({
    pair: 'GHX-USDT',
    midPrice,
    bids: [],
    asks: [],
  })
})

// Return recent trades for GHX-USDT (most recent first).
app.get('/api/market/trades', (_req, res) => {
  const recent = [...trades].slice(-100).reverse()
  res.json({ pair: 'GHX-USDT', trades: recent })
})

// Very simple market order endpoint that trades against an implicit system counterparty.
// This is NOT a real matching engine, but is enough to power a demo trading UI and price chart.
app.post('/api/market/order', (req, res) => {
  const body = req.body as {
    side?: 'BUY' | 'SELL'
    price?: number
    amount?: number
  }

  const side = body.side
  const price = body.price
  const amount = body.amount

  if (side !== 'BUY' && side !== 'SELL') {
    res.status(400).json({ ok: false, error: 'INVALID_SIDE' })
    return
  }

  if (typeof price !== 'number' || price <= 0 || !Number.isFinite(price)) {
    res.status(400).json({ ok: false, error: 'INVALID_PRICE' })
    return
  }

  if (typeof amount !== 'number' || amount <= 0 || !Number.isFinite(amount)) {
    res.status(400).json({ ok: false, error: 'INVALID_AMOUNT' })
    return
  }

  // Check balances for the demo user.
  if (side === 'BUY') {
    const cost = price * amount
    if (demoUserUsdtBalance < cost) {
      res.status(400).json({ ok: false, error: 'INSUFFICIENT_USDT' })
      return
    }

    demoUserUsdtBalance -= cost
    demoUser.balance += amount
  } else {
    if (demoUser.balance < amount) {
      res.status(400).json({ ok: false, error: 'INSUFFICIENT_GHX' })
      return
    }

    demoUser.balance -= amount
    demoUserUsdtBalance += price * amount
  }

  saveDemoUser(demoUser)

  const trade: Trade = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    pair: 'GHX-USDT',
    side,
    price,
    amount,
    timestamp: Date.now(),
  }

  trades.push(trade)
  saveTrades(trades)

  res.json({
    ok: true,
    trade,
    balances: {
      ghx: demoUser.balance,
      usdt: demoUserUsdtBalance,
    },
  })
})

// In this initial version we treat demoUser.balance as the GHX balance.
// For trading we also maintain a simple USDT balance in memory for the demo user.
let demoUserUsdtBalance = 1_000

type Trade = {
  id: string
  pair: 'GHX-USDT'
  side: 'BUY' | 'SELL'
  price: number
  amount: number
  timestamp: number
}

function loadTrades(): Trade[] {
  try {
    if (!fs.existsSync(tradesDataPath)) {
      return []
    }

    const raw = fs.readFileSync(tradesDataPath, 'utf8')
    const parsed = JSON.parse(raw) as Trade[]
    if (Array.isArray(parsed)) {
      return parsed
    }
  } catch {
    // ignore
  }

  return []
}

function saveTrades(trades: Trade[]): void {
  try {
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true })
    }

    fs.writeFileSync(tradesDataPath, JSON.stringify(trades, null, 2), 'utf8')
  } catch {
    // ignore
  }
}

let trades: Trade[] = loadTrades()

function getLastTrade(): Trade | undefined {
  if (!trades.length) return undefined
  return trades[trades.length - 1]
}

// Simple user info endpoint for the demo user.
app.get('/api/user', (_req, res) => {
  res.json({
    id: demoUser.id,
    balance: demoUser.balance,
    ownedCount: demoUser.ownedHexes.size,
  })
})

// Check if a specific hex is already owned by the demo user.
app.get('/api/hex/:h3Index/owned', (req, res) => {
  const { h3Index } = req.params

  if (!h3Index || typeof h3Index !== 'string') {
    res.status(400).json({ owned: false, error: 'INVALID_H3_INDEX' })
    return
  }

  const owned = demoUser.ownedHexes.has(h3Index)
  res.json({ owned })
})

// Return all owned hex indices for the demo user.
app.get('/api/owned-hexes', (_req, res) => {
  res.json({ hexes: Array.from(demoUser.ownedHexes) })
})

// Mining endpoint: marks a hex as mined for the demo user and increases balance by 1
// if this is the first time it is mined for this user.
app.post('/api/mine', (req, res) => {
  const { h3Index } = req.body as { h3Index?: string }

  if (!h3Index || typeof h3Index !== 'string') {
    res.status(400).json({ ok: false, error: 'INVALID_H3_INDEX' })
    return
  }

  const alreadyOwned = demoUser.ownedHexes.has(h3Index)

  if (alreadyOwned) {
    res.json({
      ok: false,
      reason: 'ALREADY_MINED',
      balance: demoUser.balance,
      owned: true,
    })
    return
  }

  demoUser.ownedHexes.add(h3Index)
  demoUser.balance += 1

  miningEvents.push({
    timestamp: Date.now(),
    h3Index,
  })
  saveMiningEvents(miningEvents)

  saveDemoUser(demoUser)

  res.json({
    ok: true,
    balance: demoUser.balance,
    owned: true,
  })
})

// Heavier endpoint used only on explicit user interaction (click on a hex).
// This tries Overpass once for the given hex and falls back on error.
app.get('/api/hex/:h3Index/osm', async (req, res) => {
  const { h3Index } = req.params

  let zoneType: ZoneType
  let debug: string[] = []

  try {
    const inferred = await inferZoneTypeFromOverpass(h3Index)
    zoneType = inferred.zoneType
    debug = inferred.debug
  } catch (err) {
    console.error('Overpass error for h3Index', h3Index, err)
    zoneType = fallbackZoneType(h3Index)
    const message = err instanceof Error ? err.message : String(err)
    debug = [`Overpass failed: ${message}`, 'Using hash-based fallback']
  }

  const result = {
    h3Index,
    zoneType,
    debug,
  }

  res.json(result)
})

app.listen(port, () => {
  console.log(`Backend listening on http://localhost:${port}`)
})
