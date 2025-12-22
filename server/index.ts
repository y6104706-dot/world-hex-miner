import express from 'express'
import cors from 'cors'
import * as h3 from 'h3-js'
import fetch from 'node-fetch'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import crypto from 'crypto'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()
const port = Number(process.env.PORT) || 4000

app.use(cors())
app.use(express.json())

app.get('/', (_req, res) => {
  res.json({ ok: true, service: 'world-hex-miner-api' })
})

type User = {
  id: string
  email: string
  passwordHash: string
  balance: number
  usdtBalance: number
  ownedHexes: Set<string>
}

function buildGlobalOwnedHexesSet(): Set<string> {
  const all = new Set<string>()
  for (const u of usersById.values()) {
    for (const idx of u.ownedHexes) {
      all.add(idx)
    }
  }
  return all
}

type StoredUser = {
  id: string
  email: string
  passwordHash: string
  balance: number
  usdtBalance: number
  ownedHexes: string[]
}

const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..', 'data')
const legacyDemoUserDataPath = path.join(dataDir, 'demoUser.json')
const usersDataPath = path.join(dataDir, 'users.json')
const hexCachePath = path.join(dataDir, 'hexCache.json')
const coastBufferPath = path.join(dataDir, 'coastBuffer.json')
const tradesDataPath = path.join(dataDir, 'marketTrades.json')
const miningEventsPath = path.join(dataDir, 'miningEvents.json')
const treasuryDataPath = path.join(dataDir, 'treasury.json')

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me'
const DEFAULT_START_HEX = '8b3f4dc1e26dfff'

// Fixed GHX cost for creating a new spawn hex (new starting point) for the
// demo user. In later versions this can be made configurable and split into
// burn / treasury shares.
const SPAWN_COST_GHX = 5

// Fixed GHX cost for a simple Drive Mode simulation. In this MVP endpoint the
// user pays DRIVE_COST_GHX once to claim a batch of nearby MAIN_ROAD hexes
// around a chosen centre hex.
const DRIVE_COST_GHX = 5

// Radius (in hex rings) around the provided centre hex to consider for Drive
// Mode simulation. gridDisk with k=2 yields 19 cells, k=3 yields 37, etc. We
// keep this modest to avoid excessive Overpass calls in the centroid
// classifier, but large enough so that a typical road corridor yields several
// candidate hexes.
const DRIVE_DISK_K = 3

const GPS_MINE_ACCURACY_THRESHOLD_M = 35
const GPS_MINE_MAX_AGE_MS = 15_000

type StoredUsersFile = {
  users: StoredUser[]
}

function coerceStoredUserToUser(stored: StoredUser): User {
  return {
    id: stored.id,
    email: stored.email,
    passwordHash: stored.passwordHash,
    balance: typeof stored.balance === 'number' ? stored.balance : 0,
    usdtBalance: typeof stored.usdtBalance === 'number' ? stored.usdtBalance : 1_000,
    ownedHexes: new Set<string>(Array.isArray(stored.ownedHexes) ? stored.ownedHexes : []),
  }
}

function loadUsers(): Map<string, User> {
  try {
    if (fs.existsSync(usersDataPath)) {
      const raw = fs.readFileSync(usersDataPath, 'utf8')
      const parsed = JSON.parse(raw) as StoredUsersFile
      const users = Array.isArray(parsed?.users) ? parsed.users : []
      const map = new Map<string, User>()
      for (const u of users) {
        if (u && typeof u.id === 'string' && typeof u.email === 'string' && typeof u.passwordHash === 'string') {
          map.set(u.id, coerceStoredUserToUser(u))
        }
      }
      return map
    }

    // One-time migration: if legacy demoUser.json exists, convert it into a
    // login-able user for local testing.
    if (fs.existsSync(legacyDemoUserDataPath)) {
      const raw = fs.readFileSync(legacyDemoUserDataPath, 'utf8')
      const legacy = JSON.parse(raw) as { id?: string; balance?: number; ownedHexes?: string[] }
      const id = typeof legacy.id === 'string' ? legacy.id : 'demo-user'
      const balance = typeof legacy.balance === 'number' ? legacy.balance : 0
      const ownedHexes = Array.isArray(legacy.ownedHexes) ? legacy.ownedHexes : []
      const passwordHash = bcrypt.hashSync('demo', 10)
      const demo: User = {
        id,
        email: 'demo@local',
        passwordHash,
        balance,
        usdtBalance: 1_000,
        ownedHexes: new Set<string>(ownedHexes.length ? ownedHexes : [DEFAULT_START_HEX]),
      }
      const map = new Map<string, User>()
      map.set(demo.id, demo)
      saveUsers(map)
      return map
    }
  } catch {
    // ignore and fall through
  }

  return new Map<string, User>()
}

function saveUsers(users: Map<string, User>): void {
  try {
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true })
    }

    const stored: StoredUsersFile = {
      users: Array.from(users.values()).map((u) => ({
        id: u.id,
        email: u.email,
        passwordHash: u.passwordHash,
        balance: u.balance,
        usdtBalance: u.usdtBalance,
        ownedHexes: Array.from(u.ownedHexes),
      })),
    }

    fs.writeFileSync(usersDataPath, JSON.stringify(stored, null, 2), 'utf8')
  } catch {
    // ignore persistence errors for demo purposes
  }
}

const usersById: Map<string, User> = loadUsers()

function findUserByEmail(emailRaw: string): User | undefined {
  const email = emailRaw.trim().toLowerCase()
  for (const u of usersById.values()) {
    if (u.email.toLowerCase() === email) return u
  }
  return undefined
}

function createUser(emailRaw: string, passwordRaw: string): User {
  const email = emailRaw.trim().toLowerCase()
  const id = crypto.randomUUID()
  const passwordHash = bcrypt.hashSync(passwordRaw, 10)
  const user: User = {
    id,
    email,
    passwordHash,
    balance: 10,
    usdtBalance: 1_000,
    ownedHexes: new Set<string>([DEFAULT_START_HEX]),
  }
  usersById.set(id, user)
  saveUsers(usersById)
  return user
}

type AuthTokenPayload = {
  userId: string
}

function signAuthToken(user: User): string {
  const payload: AuthTokenPayload = { userId: user.id }
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' })
}

function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const header = req.headers.authorization
  if (!header || typeof header !== 'string' || !header.startsWith('Bearer ')) {
    res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' })
    return
  }

  const token = header.slice('Bearer '.length)
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as AuthTokenPayload
    const userId = decoded?.userId
    if (!userId || typeof userId !== 'string') {
      res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' })
      return
    }
    const user = usersById.get(userId)
    if (!user) {
      res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' })
      return
    }
    ;(req as express.Request & { user: User }).user = user
    next()
  } catch {
    res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' })
  }
}

type HexCacheEntry = {
  zoneType: ZoneType
  debug: string[]
}

function applyCoastBufferFromCache(
  h3Index: string,
  base: { zoneType: ZoneType; debug: string[]; hasRoad?: boolean; roadClass?: string },
): { zoneType: ZoneType; debug: string[]; hasRoad?: boolean; roadClass?: string } {
  // Expand COAST to a small buffer zone around cached coastline hexes.
  // IMPORTANT: do NOT write this derived result back into hexCache, otherwise
  // the buffer would recursively grow.
  const COAST_BUFFER_K = 3

  // Do not override high-priority safety / infrastructure zones.
  const nonOverridable = new Set<ZoneType>(['MILITARY', 'PRISON', 'HOSPITAL', 'MAIN_ROAD', 'CLIFF'])
  if (nonOverridable.has(base.zoneType)) {
    return base
  }

  try {
    const disk = h3.gridDisk(h3Index, COAST_BUFFER_K)
    for (const idx of disk) {
      if (hexCache[idx]?.zoneType === 'COAST') {
        return {
          ...base,
          zoneType: 'COAST',
          debug: [...base.debug, `Coast buffer: within ${COAST_BUFFER_K} hexes of cached coastline`],
        }
      }
    }
  } catch {
    // ignore
  }

  return base
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

function loadCoastBuffer(): Set<string> {
  try {
    if (!fs.existsSync(coastBufferPath)) {
      return new Set()
    }
    const raw = fs.readFileSync(coastBufferPath, 'utf8')
    const parsed = JSON.parse(raw) as { hexes?: unknown }
    const hexes = (parsed && typeof parsed === 'object' ? (parsed as any).hexes : null) as unknown
    if (Array.isArray(hexes)) {
      return new Set(hexes.filter((x) => typeof x === 'string') as string[])
    }
  } catch {
    // ignore
  }
  return new Set()
}

function saveCoastBuffer(set: Set<string>): void {
  try {
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true })
    }
    fs.writeFileSync(coastBufferPath, JSON.stringify({ hexes: Array.from(set) }, null, 2), 'utf8')
  } catch {
    // ignore
  }
}

const coastBufferHexes: Set<string> = loadCoastBuffer()

function markCoastAndBuffer(h3Index: string): void {
  const COAST_BUFFER_K = 4
  try {
    const disk = h3.gridDisk(h3Index, COAST_BUFFER_K)
    let changed = false
    for (const idx of disk) {
      if (!coastBufferHexes.has(idx)) {
        coastBufferHexes.add(idx)
        changed = true
      }
    }
    if (changed) {
      saveCoastBuffer(coastBufferHexes)
    }
  } catch {
    // ignore
  }
}

type MiningEvent = {
  timestamp: number
  userId: string
  h3Index: string
}

type TreasuryFile = {
  ghxBalance: number
}

function loadTreasury(): TreasuryFile {
  try {
    if (!fs.existsSync(treasuryDataPath)) {
      return { ghxBalance: 0 }
    }
    const raw = fs.readFileSync(treasuryDataPath, 'utf8')
    const parsed = JSON.parse(raw) as { ghxBalance?: number }
    return { ghxBalance: typeof parsed?.ghxBalance === 'number' ? parsed.ghxBalance : 0 }
  } catch {
    return { ghxBalance: 0 }
  }
}

function saveTreasury(treasury: TreasuryFile): void {
  try {
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true })
    }
    fs.writeFileSync(treasuryDataPath, JSON.stringify(treasury, null, 2), 'utf8')
  } catch {
    // ignore persistence errors for demo purposes
  }
}

const treasury: TreasuryFile = loadTreasury()

function collectTreasuryFee(amount: number): void {
  if (!Number.isFinite(amount) || amount <= 0) return
  treasury.ghxBalance += amount
  saveTreasury(treasury)
}

function loadMiningEvents(): MiningEvent[] {
  try {
    if (!fs.existsSync(miningEventsPath)) {
      return []
    }

    const raw = fs.readFileSync(miningEventsPath, 'utf8')
    const parsed = JSON.parse(raw) as Array<{ timestamp?: number; h3Index?: string; userId?: string }>
    if (Array.isArray(parsed)) {
      return parsed
        .filter((e) => typeof e?.timestamp === 'number' && typeof e?.h3Index === 'string')
        .map((e) => ({
          timestamp: e.timestamp as number,
          h3Index: e.h3Index as string,
          userId: typeof e.userId === 'string' ? e.userId : 'demo-user',
        }))
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
  | 'INTERURBAN'
  | 'MILITARY'
  | 'HOSPITAL'
  | 'CLIFF'
  | 'COAST'
  | 'NATURE_RESERVE'
  | 'RIVER'
  | 'PRISON'
  | 'GOVERNMENT'

function fallbackZoneType(h3Index: string): ZoneType {
  // Simple heuristic fallback based purely on latitude to separate "SEA" from
  // everything else when Overpass is unavailable.
  const [lat] = h3.cellToLatLng(h3Index)
  if (lat > 73 || lat < -73) {
    return 'SEA'
  }

  return 'INTERURBAN'
}

type OverpassElement = {
  type: string
  tags?: Record<string, string>
}

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.nchc.org.tw/api/interpreter',
]

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function overpassFetch(query: string): Promise<{ elements: OverpassElement[] }> {
  const maxAttempts = 4

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const endpoint = OVERPASS_ENDPOINTS[attempt % OVERPASS_ENDPOINTS.length]
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain',
        },
        body: query,
      })

      if (response.ok) {
        const data = (await response.json()) as { elements?: OverpassElement[] }
        return { elements: data.elements ?? [] }
      }

      // Retry on rate limits and transient server errors.
      if (response.status === 429 || (response.status >= 500 && response.status <= 599)) {
        const backoffMs = 400 * Math.pow(2, attempt)
        await sleep(backoffMs)
        continue
      }

      throw new Error(`Overpass error: ${response.status}`)
    } catch (err) {
      // Network errors: retry with backoff.
      if (attempt < maxAttempts - 1) {
        const backoffMs = 400 * Math.pow(2, attempt)
        await sleep(backoffMs)
        continue
      }
      throw err
    }
  }

  throw new Error('Overpass error: exhausted retries')
}

type InferredZone = {
  zoneType: ZoneType
  debug: string[]
  hasRoad?: boolean
  roadClass?: string
}

export async function inferZoneTypeFromOverpass(h3Index: string): Promise<InferredZone> {
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

      // Prisons / secure government facilities
      node["amenity"="prison"](${south},${west},${north},${east});
      way["amenity"="prison"](${south},${west},${north},${east});
      node["building"="government"](${south},${west},${north},${east});
      way["building"="government"](${south},${west},${north},${east});

      // Hospitals
      node["amenity"="hospital"](${south},${west},${north},${east});
      way["amenity"="hospital"](${south},${west},${north},${east});

      // Nature reserves / forests / parks / green urban
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

      // General urban fabric (buildings / residential / commercial / industrial)
      way["building"](${south},${west},${north},${east});
      relation["building"](${south},${west},${north},${east});
      way["landuse"="residential"](${south},${west},${north},${east});
      way["landuse"="commercial"](${south},${west},${north},${east});
      way["landuse"="industrial"](${south},${west},${north},${east});
      relation["landuse"="residential"](${south},${west},${north},${east});
      relation["landuse"="commercial"](${south},${west},${north},${east});
      relation["landuse"="industrial"](${south},${west},${north},${east});
      node["place"="city"](${south},${west},${north},${east});
      node["place"="town"](${south},${west},${north},${east});
      node["place"="village"](${south},${west},${north},${east});

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
      way["natural"="beach"](${south},${west},${north},${east});
      way["leisure"="beach"](${south},${west},${north},${east});
      way["natural"="cliff"](${south},${west},${north},${east});
    );
    out body;
  `

  const elements = (await overpassFetch(overpassQuery)).elements

  const debug: string[] = []

  let hasMainRoad = false
  let hasSea = false
  let hasNature = false
  let hasUrban = false
  let hasMilitary = false
  let hasHospital = false
  let hasPrisonOrGovernment = false
  let hasCoast = false
  let hasCliff = false
  let hasRoad = false
  let roadClass: string | undefined

  // Scan all elements once, set simple flags for each type of tag we care
  // about. We then apply a very clear global priority so that true
  // intercity/high-speed roads (motorway/trunk) are classified as MAIN_ROAD
  // and are not overridden by small patches of water/parks, while typical
  // built-up areas without such roads are classified as URBAN.
  for (const el of elements) {
    const tags = el.tags ?? {}

    if (tags.landuse === 'military' || tags.military) {
      hasMilitary = true
    }

    if (tags.amenity === 'hospital') {
      hasHospital = true
    }

    if (tags.amenity === 'prison' || tags.building === 'government') {
      hasPrisonOrGovernment = true
    }

    // MAIN_ROAD: only the very fastest / most significant highways (motorways
    // and trunks). Primary roads will be treated as URBAN when buildings or
    // residential landuse are present. We still track any highway as a road
    // candidate for future use (veins along roads, etc.).
    if (tags.highway) {
      hasRoad = true
      // keep the strongest roadClass we have seen so far, with a simple
      // priority ordering.
      const roadPriority: Record<string, number> = {
        motorway: 4,
        trunk: 3,
        primary: 2,
        secondary: 1,
      }
      const current = roadClass ? roadPriority[roadClass] ?? 0 : 0
      const next = roadPriority[tags.highway] ?? 0
      if (next > current) {
        roadClass = tags.highway
      }
      const mainRoads = new Set<string>(['motorway', 'trunk'])
      if (mainRoads.has(tags.highway)) {
        hasMainRoad = true
      }
    }

    // SEA: general water / sea polygons
    if (tags.natural === 'sea' || tags.natural === 'water' || tags.place === 'sea' || tags.water) {
      hasSea = true
    }

    if (tags.natural === 'coastline' || tags.natural === 'beach' || tags.leisure === 'beach') {
      hasCoast = true
    }

    if (tags.natural === 'cliff') {
      hasCliff = true
    }

    // NATURE_RESERVE: park / forest / wood
    if (tags.leisure === 'park' || tags.landuse === 'forest' || tags.natural === 'wood') {
      hasNature = true
    }

    // URBAN: buildings / dense landuse / settlement places
    if (
      tags.building ||
      tags.landuse === 'residential' ||
      tags.landuse === 'commercial' ||
      tags.landuse === 'industrial' ||
      tags.place === 'city' ||
      tags.place === 'town' ||
      tags.place === 'village'
    ) {
      hasUrban = true
    }
  }

  // Global priority for bbox-based classifier:
  // 1) MILITARY / PRISON / GOVERNMENT
  // 2) HOSPITAL
  // 3) MAIN_ROAD – real intercity / high-speed roads (motorway/trunk)
  // 4) CLIFF / COAST
  // 5) URBAN – buildings, residential/commercial/industrial landuse, settlements
  // 6) SEA – strong water/sea signal when there is no road/urban fabric
  // 7) NATURE_RESERVE – parks / forests / woods away from dense urban fabric
  if (hasMilitary || hasPrisonOrGovernment) {
    if (hasMilitary) {
      debug.push('OSM: military tag detected')
      return { zoneType: 'MILITARY', debug, hasRoad, roadClass }
    }

    debug.push('OSM: prison/government tag detected')
    return { zoneType: 'PRISON', debug, hasRoad, roadClass }
  }

  if (hasHospital) {
    debug.push('OSM: hospital tag detected')
    return { zoneType: 'HOSPITAL', debug, hasRoad, roadClass }
  }

  if (hasMainRoad) {
    debug.push('OSM: main road detected (motorway/trunk)')
    return { zoneType: 'MAIN_ROAD', debug, hasRoad, roadClass }
  }

  if (hasCliff) {
    debug.push('OSM: cliff tag detected')
    return { zoneType: 'CLIFF', debug, hasRoad, roadClass }
  }

  if (hasCoast) {
    debug.push('OSM: coastline/beach tag detected')
    // Persist a safety buffer around detected coastline so mining can be
    // forbidden near coasts even if nearby hexes are not classified as COAST.
    markCoastAndBuffer(h3Index)
    return { zoneType: 'COAST', debug, hasRoad, roadClass }
  }

  if (hasUrban) {
    debug.push('OSM: urban fabric tag detected')
    return { zoneType: 'URBAN', debug, hasRoad, roadClass }
  }

  if (hasSea) {
    debug.push('OSM: water/sea tag detected')
    return { zoneType: 'SEA', debug, hasRoad, roadClass }
  }

  if (hasNature) {
    debug.push('OSM: park / forest / wood detected')
    return { zoneType: 'NATURE_RESERVE', debug, hasRoad, roadClass }
  }

  debug.push('OSM: no matching tags found, defaulting to INTERURBAN (global fallback)')
  return { zoneType: 'INTERURBAN', debug, hasRoad, roadClass }
}

// Experimental classifier that looks only around the centroid of the hex,
// instead of the full bounding box. This is intended to give a more "local"
// reading of what is actually under the centre of the hex.
export async function inferZoneTypeAtCentroid(h3Index: string): Promise<InferredZone> {
  const [lat, lng] = h3.cellToLatLng(h3Index)

  // Small search radius in metres (approx) for Overpass "around" queries.
  const radiusMeters = 60

  const overpassQuery = `
    [out:json][timeout:10];
    (
      way["highway"](around:${radiusMeters},${lat},${lng});

      way["landuse"="military"](around:${radiusMeters},${lat},${lng});
      node["military"](around:${radiusMeters},${lat},${lng});

      node["amenity"="prison"](around:${radiusMeters},${lat},${lng});
      way["amenity"="prison"](around:${radiusMeters},${lat},${lng});
      node["building"="government"](around:${radiusMeters},${lat},${lng});
      way["building"="government"](around:${radiusMeters},${lat},${lng});

      node["amenity"="hospital"](around:${radiusMeters},${lat},${lng});
      way["amenity"="hospital"](around:${radiusMeters},${lat},${lng});

      way["natural"="sea"](around:${radiusMeters},${lat},${lng});
      relation["natural"="sea"](around:${radiusMeters},${lat},${lng});
      way["natural"="water"](around:${radiusMeters},${lat},${lng});
      relation["natural"="water"](around:${radiusMeters},${lat},${lng});
      way["place"="sea"](around:${radiusMeters},${lat},${lng});
      relation["place"="sea"](around:${radiusMeters},${lat},${lng});
      way["water"](around:${radiusMeters},${lat},${lng});
      relation["water"](around:${radiusMeters},${lat},${lng});

      way["leisure"="park"](around:${radiusMeters},${lat},${lng});
      way["landuse"="forest"](around:${radiusMeters},${lat},${lng});
      way["natural"="wood"](around:${radiusMeters},${lat},${lng});

      way["building"](around:${radiusMeters},${lat},${lng});
      way["landuse"="residential"](around:${radiusMeters},${lat},${lng});
      way["landuse"="commercial"](around:${radiusMeters},${lat},${lng});
      way["landuse"="industrial"](around:${radiusMeters},${lat},${lng});
      node["place"="city"](around:${radiusMeters},${lat},${lng});
      node["place"="town"](around:${radiusMeters},${lat},${lng});
      node["place"="village"](around:${radiusMeters},${lat},${lng});
    );
    out body;
  `

  const elements = (await overpassFetch(overpassQuery)).elements

  const debug: string[] = []

  let hasMainRoad = false
  let hasSea = false
  let hasNature = false
  let hasUrban = false
  let hasMilitary = false
  let hasHospital = false
  let hasPrisonOrGovernment = false
  let hasRoad = false
  let roadClass: string | undefined

  for (const el of elements) {
    const tags = el.tags ?? {}

    if (tags.landuse === 'military' || tags.military) {
      hasMilitary = true
    }

    if (tags.amenity === 'hospital') {
      hasHospital = true
    }

    if (tags.amenity === 'prison' || tags.building === 'government') {
      hasPrisonOrGovernment = true
    }

    if (tags.highway) {
      hasRoad = true
      const roadPriority: Record<string, number> = {
        motorway: 4,
        trunk: 3,
        primary: 2,
        secondary: 1,
      }
      const current = roadClass ? roadPriority[roadClass] ?? 0 : 0
      const next = roadPriority[tags.highway] ?? 0
      if (next > current) {
        roadClass = tags.highway
      }

      const mainRoads = new Set<string>(['motorway', 'trunk'])
      if (mainRoads.has(tags.highway)) {
        hasMainRoad = true
      }
    }

    if (tags.natural === 'sea' || tags.natural === 'water' || tags.place === 'sea' || tags.water) {
      hasSea = true
    }

    if (tags.leisure === 'park' || tags.landuse === 'forest' || tags.natural === 'wood') {
      hasNature = true
    }

    if (
      tags.building ||
      tags.landuse === 'residential' ||
      tags.landuse === 'commercial' ||
      tags.landuse === 'industrial' ||
      tags.place === 'city' ||
      tags.place === 'town' ||
      tags.place === 'village'
    ) {
      hasUrban = true
    }
  }

  // Global priority for centroid-based classifier mirrors the bbox logic:
  // 1) MILITARY / PRISON / GOVERNMENT
  // 2) HOSPITAL
  // 3) MAIN_ROAD (motorway/trunk)
  // 4) URBAN
  // 5) SEA
  // 6) NATURE_RESERVE
  if (hasMilitary || hasPrisonOrGovernment) {
    if (hasMilitary) {
      debug.push('Centroid: military tag detected')
      return { zoneType: 'MILITARY', debug, hasRoad, roadClass }
    }

    debug.push('Centroid: prison/government tag detected')
    return { zoneType: 'PRISON', debug, hasRoad, roadClass }
  }

  if (hasHospital) {
    debug.push('Centroid: hospital tag detected')
    return { zoneType: 'HOSPITAL', debug, hasRoad, roadClass }
  }

  if (hasMainRoad) {
    debug.push('Centroid: main road detected (motorway/trunk)')
    return { zoneType: 'MAIN_ROAD', debug, hasRoad, roadClass }
  }

  if (hasUrban) {
    debug.push('Centroid: urban fabric tag detected')
    return { zoneType: 'URBAN', debug, hasRoad, roadClass }
  }

  if (hasSea) {
    debug.push('Centroid: water/sea tag detected')
    return { zoneType: 'SEA', debug, hasRoad, roadClass }
  }

  if (hasNature) {
    debug.push('Centroid: park / forest / wood detected')
    return { zoneType: 'NATURE_RESERVE', debug, hasRoad, roadClass }
  }

  debug.push('Centroid: no matching tags found, defaulting to SEA (global fallback)')
  return { zoneType: 'SEA', debug, hasRoad, roadClass }
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
      // Only cache successful Overpass classifications. This keeps hexCache
      // free from fallback SEA values that are caused purely by temporary
      // Overpass errors (rate limits, network issues, etc.).
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
      // IMPORTANT: do NOT write this fallback result into hexCache. We want
      // the cache to contain only "real" OSM-based classifications so that
      // temporary Overpass failures do not permanently pollute the map.
    }
  }

  const coastAware = applyCoastBufferFromCache(h3Index, { zoneType: entry.zoneType, debug: entry.debug })

  const result = {
    h3Index,
    zoneType: coastAware.zoneType,
    debug: coastAware.debug,
  }

  res.json(result)
})

// Experimental endpoint that exposes the centroid-based classifier so we can
// compare its behaviour against the bbox-based version in the UI.
app.get('/api/hex/:h3Index/classify-centroid', async (req, res) => {
  const { h3Index } = req.params

  let zoneType: ZoneType
  let debug: string[] = []
  let hasRoad: boolean | undefined
  let roadClass: string | undefined

  try {
    const inferred = await inferZoneTypeAtCentroid(h3Index)
    zoneType = inferred.zoneType
    debug = inferred.debug
    hasRoad = inferred.hasRoad
    roadClass = inferred.roadClass
  } catch (err) {
    console.error('Overpass centroid error for h3Index', h3Index, err)
    zoneType = fallbackZoneType(h3Index)
    const message = err instanceof Error ? err.message : String(err)
    debug = [`Centroid Overpass failed: ${message}`, 'Using fallback']
  }

  res.json({
    h3Index,
    zoneType,
    debug,
    hasRoad,
    roadClass,
  })
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
app.get('/api/market/balance', requireAuth, (req, res) => {
  const user = (req as express.Request & { user: User }).user
  res.json({
    userId: user.id,
    ghx: user.balance,
    usdt: user.usdtBalance,
  })
})

// Ticker endpoint for GHX-USDT – based on the last trade if available.
app.get('/api/market/ticker', (req, res) => {
  const trades = loadTrades()
  if (trades.length === 0) {
    res.json({ lastPrice: null })
    return
  }
  const last = trades[trades.length - 1]
  const now = Date.now()
  const dayAgo = now - 24 * 60 * 60 * 1000
  let volume24h = 0
  let trades24h = 0
  let vwapNumerator = 0
  let vwapDenominator = 0
  let firstTradeInWindow: Trade | undefined

  for (const t of trades) {
    if (t.timestamp >= dayAgo) {
      volume24h += t.amount
      trades24h += 1
      vwapNumerator += t.price * t.amount
      vwapDenominator += t.amount
      if (!firstTradeInWindow || t.timestamp < firstTradeInWindow.timestamp) {
        firstTradeInWindow = t
      }
    }
  }

  const vwap24h = vwapDenominator > 0 ? vwapNumerator / vwapDenominator : null
  let change24h: number | null = null
  if (firstTradeInWindow && firstTradeInWindow.price > 0) {
    change24h = ((last.price - firstTradeInWindow.price) / firstTradeInWindow.price) * 100
  }

  res.json({
    pair: 'GHX-USDT',
    lastPrice: last.price,
    volume24h,
    trades: trades24h,
    vwap24h,
    change24h,
  })
})

app.get('/api/treasury', requireAuth, (req, res) => {
  res.json({ ghxBalance: treasury.ghxBalance })
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
app.post('/api/market/order', requireAuth, (req, res) => {
  const user = (req as express.Request & { user: User | undefined }).user
  if (!user) {
    res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' })
    return
  }

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

  // Check balances for the authenticated user.
  if (side === 'BUY') {
    const cost = price * amount
    if (user.usdtBalance < cost) {
      res.status(400).json({ ok: false, error: 'INSUFFICIENT_USDT' })
      return
    }

    user.usdtBalance -= cost
    user.balance += amount
  } else {
    if (user.balance < amount) {
      res.status(400).json({ ok: false, error: 'INSUFFICIENT_GHX' })
      return
    }

    user.balance -= amount
    user.usdtBalance += price * amount
  }

  saveUsers(usersById)

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
      ghx: user.balance,
      usdt: user.usdtBalance,
    },
  })
})

// USDT balances are now stored per user.

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

app.post('/api/auth/register', (req, res) => {
  const body = req.body as { email?: string; password?: string }
  const email = body.email
  const password = body.password

  if (!email || typeof email !== 'string' || !email.includes('@')) {
    res.status(400).json({ ok: false, error: 'INVALID_EMAIL' })
    return
  }

  if (!password || typeof password !== 'string' || password.length < 6) {
    res.status(400).json({ ok: false, error: 'INVALID_PASSWORD' })
    return
  }

  if (findUserByEmail(email)) {
    res.status(400).json({ ok: false, error: 'EMAIL_IN_USE' })
    return
  }

  const user = createUser(email, password)
  const token = signAuthToken(user)
  res.json({
    ok: true,
    token,
    user: {
      id: user.id,
      email: user.email,
      balance: user.balance,
      ownedCount: user.ownedHexes.size,
    },
  })
})

app.post('/api/auth/login', (req, res) => {
  const body = req.body as { email?: string; password?: string }
  const email = body.email
  const password = body.password

  if (!email || typeof email !== 'string' || !password || typeof password !== 'string') {
    res.status(400).json({ ok: false, error: 'INVALID_CREDENTIALS' })
    return
  }

  const user = findUserByEmail(email)
  if (!user) {
    res.status(401).json({ ok: false, error: 'INVALID_CREDENTIALS' })
    return
  }

  const ok = bcrypt.compareSync(password, user.passwordHash)
  if (!ok) {
    res.status(401).json({ ok: false, error: 'INVALID_CREDENTIALS' })
    return
  }

  const token = signAuthToken(user)
  res.json({
    ok: true,
    token,
    user: {
      id: user.id,
      email: user.email,
      balance: user.balance,
      ownedCount: user.ownedHexes.size,
    },
  })
})

app.get('/api/user', requireAuth, (req, res) => {
  const user = (req as express.Request & { user: User }).user
  res.json({
    id: user.id,
    balance: user.balance,
    ownedCount: user.ownedHexes.size,
  })
})

app.get('/api/me', requireAuth, (req, res) => {
  const user = (req as express.Request & { user: User }).user
  res.json({
    id: user.id,
    email: user.email,
    ghxBalance: user.balance,
    usdtBalance: user.usdtBalance,
    ownedCount: user.ownedHexes.size,
    ownedHexes: Array.from(user.ownedHexes),
  })
})

// Check if a specific hex is already owned by the demo user.
app.get('/api/hex/:h3Index/owned', requireAuth, (req, res) => {
  const { h3Index } = req.params

  if (!h3Index || typeof h3Index !== 'string') {
    res.status(400).json({ owned: false, error: 'INVALID_H3_INDEX' })
    return
  }

  const user = (req as express.Request & { user?: User }).user
  if (!user) {
    res.status(401).json({ owned: false, error: 'UNAUTHENTICATED' })
    return
  }

  const owned = user.ownedHexes.has(h3Index)
  res.json({ owned })
})

// Return all owned hex indices for the demo user.
app.get('/api/owned-hexes', requireAuth, (req, res) => {
  const user = (req as express.Request & { user: User }).user
  res.json({ hexes: Array.from(user.ownedHexes) })
})

app.get('/api/owned-hexes/global', requireAuth, (req, res) => {
  const user = (req as express.Request & { user: User }).user

  const mine = Array.from(user.ownedHexes)
  const mineSet = new Set(mine)

  const othersSet = new Set<string>()
  for (const other of usersById.values()) {
    if (other.id === user.id) {
      continue
    }
    for (const idx of other.ownedHexes) {
      if (!mineSet.has(idx)) {
        othersSet.add(idx)
      }
    }
  }

  res.json({ mine, others: Array.from(othersSet) })
})

// Drive Mode simulation endpoint: given a centre H3 index, look at nearby
// hexes within DRIVE_DISK_K rings, classify them via the centroid-based OSM
// classifier and claim those that are MAIN_ROAD for the demo user in exchange
// for a fixed GHX fee. This is an MVP for "Drive Mode" mining and does not
// attempt to model real GPS paths yet.
app.post('/api/drive/simulate', requireAuth, async (req, res) => {
  const user = (req as express.Request & { user?: User }).user
  if (!user) {
    res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' })
    return
  }

  const { centerH3Index } = req.body as { centerH3Index?: string }

  if (!centerH3Index || typeof centerH3Index !== 'string') {
    res.status(400).json({ ok: false, error: 'INVALID_H3_INDEX' })
    return
  }

  // Basic validation that this is a plausible H3 index; if not, fail fast.
  try {
    // h3.cellToLatLng will throw on invalid input.
    h3.cellToLatLng(centerH3Index)
  } catch {
    res.status(400).json({ ok: false, error: 'INVALID_H3_INDEX' })
    return
  }

  if (user.balance < DRIVE_COST_GHX) {
    res.json({
      ok: false,
      reason: 'INSUFFICIENT_GHX',
      balance: user.balance,
    })
    return
  }

  const candidates = h3.gridDisk(centerH3Index, DRIVE_DISK_K)

  const newlyClaimed: string[] = []

  for (const idx of candidates) {
    if (user.ownedHexes.has(idx)) {
      continue
    }

    try {
      const inferred = await inferZoneTypeAtCentroid(idx)

      // Treat any hex that actually intersects a road as a valid Drive Mode
      // target, not only those whose dominant zoneType is MAIN_ROAD. This
      // makes Drive Mode more visible in mixed urban areas where roads share
      // space with buildings/landuse.
      const isRoadHex = inferred.zoneType === 'MAIN_ROAD' || inferred.hasRoad
      if (!isRoadHex) {
        continue
      }
    } catch {
      // If classification fails for this hex, just skip it.
      continue
    }

    newlyClaimed.push(idx)
  }

  if (newlyClaimed.length === 0) {
    res.json({
      ok: false,
      reason: 'NO_ROAD_HEXES',
      balance: user.balance,
    })
    return
  }

  // Deduct Drive Mode cost once for this batch and then apply a standard
  // mining reward of +1 GHX per successfully claimed road hex, similar to
  // manual mining. Net effect: balance changes by (newlyClaimed.length -
  // DRIVE_COST_GHX).
  user.balance -= DRIVE_COST_GHX
  collectTreasuryFee(DRIVE_COST_GHX)

  for (const idx of newlyClaimed) {
    user.ownedHexes.add(idx)
    user.balance += 1
    miningEvents.push({
      timestamp: Date.now(),
      userId: user.id,
      h3Index: idx,
    })
  }

  saveMiningEvents(miningEvents)
  saveUsers(usersById)

  res.json({
    ok: true,
    addedHexes: newlyClaimed.length,
    ghxCost: DRIVE_COST_GHX,
    newBalance: user.balance,
    claimedHexes: newlyClaimed,
  })
})

// Drive Mode step endpoint: simulates movement along a road between two
// hexes. Given a starting hex (fromH3) and a target hex (toH3), we consider a
// corridor around both and mine any new road hexes on the way. This is a
// simplified "mouse driving" model that can later be wired to real GPS
// samples.
app.post('/api/drive/step', requireAuth, async (req, res) => {
  const user = (req as express.Request & { user?: User }).user
  if (!user) {
    res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' })
    return
  }

  const { fromH3, toH3 } = req.body as { fromH3?: string; toH3?: string }

  if (!fromH3 || !toH3 || typeof fromH3 !== 'string' || typeof toH3 !== 'string') {
    res.status(400).json({ ok: false, error: 'INVALID_H3_INDEX' })
    return
  }

  if (fromH3 === toH3) {
    res.json({ ok: false, reason: 'SAME_HEX', balance: user.balance })
    return
  }

  // Validate indices are plausible; h3-js will throw on invalid.
  try {
    h3.cellToLatLng(fromH3)
    h3.cellToLatLng(toH3)
  } catch {
    res.status(400).json({ ok: false, error: 'INVALID_H3_INDEX' })
    return
  }

  // Mine only the exact H3 path between fromH3 and toH3. This models
  // "GPS touched hexes" much more closely than mining a wide corridor.
  let path: string[] = []
  try {
    path = h3.gridPathCells(fromH3, toH3)
  } catch {
    // If no valid path exists (e.g. mismatch resolution or internal errors),
    // fall back to only the destination hex.
    path = [toH3]
  }

  const newlyMined: string[] = []

  for (const idx of path) {
    if (user.ownedHexes.has(idx)) {
      continue
    }

    try {
      const inferred = await inferZoneTypeAtCentroid(idx)
      const isRoadHex = inferred.zoneType === 'MAIN_ROAD' || inferred.hasRoad
      if (!isRoadHex) {
        continue
      }
    } catch {
      continue
    }

    newlyMined.push(idx)
  }

  // If OSM-based classification fails to find any explicit road hexes but the
  // target hex is still unowned, fall back to at least mining the target hex
  // itself. This makes Drive Mode behaviour more intuitive when driving along
  // long intercity segments that are sparsely tagged in OSM.
  if (newlyMined.length === 0 && !user.ownedHexes.has(toH3)) {
    newlyMined.push(toH3)
  }

  const N = newlyMined.length

  if (N === 0) {
    res.json({ ok: false, reason: 'NO_ROAD_HEXES', balance: user.balance })
    return
  }

  // Reward: +1 GHX per mined hex; Fee: 10% of N, floored. No minimum.
  const grossReward = N
  const fee = Math.floor(0.1 * N)
  const netDelta = grossReward - fee

  user.balance += netDelta
  collectTreasuryFee(fee)

  for (const idx of newlyMined) {
    user.ownedHexes.add(idx)
    miningEvents.push({
      timestamp: Date.now(),
      userId: user.id,
      h3Index: idx,
    })
  }

  saveMiningEvents(miningEvents)
  saveUsers(usersById)

  res.json({
    ok: true,
    minedHexes: newlyMined,
    count: N,
    grossReward,
    fee,
    netDelta,
    newBalance: user.balance,
  })
})

// Spawn endpoint: lets the demo user pay GHX to create a new starting hex
// (spawn) even if it is not adjacent to existing owned hexes. This is the
// on-chain economic primitive for opening a new local mining area.
app.post('/api/spawn', requireAuth, (req, res) => {
  const user = (req as express.Request & { user?: User }).user
  if (!user) {
    res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' })
    return
  }

  const { h3Index, lat, lon, accuracyM, gpsAt } = req.body as {
    h3Index?: string
    lat?: number
    lon?: number
    accuracyM?: number
    gpsAt?: number
  }

  if (!h3Index || typeof h3Index !== 'string') {
    res.status(400).json({ ok: false, error: 'INVALID_H3_INDEX' })
    return
  }

  if (
    typeof lat !== 'number' ||
    typeof lon !== 'number' ||
    typeof accuracyM !== 'number' ||
    typeof gpsAt !== 'number' ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    !Number.isFinite(accuracyM) ||
    !Number.isFinite(gpsAt)
  ) {
    res.json({ ok: false, reason: 'GPS_REQUIRED', balance: user.balance, owned: false })
    return
  }

  const now = Date.now()
  if (now - gpsAt > GPS_MINE_MAX_AGE_MS) {
    res.json({ ok: false, reason: 'GPS_STALE', balance: user.balance, owned: false })
    return
  }

  if (accuracyM > GPS_MINE_ACCURACY_THRESHOLD_M) {
    res.json({
      ok: false,
      reason: 'GPS_ACCURACY_LOW',
      balance: user.balance,
      owned: false,
      thresholdM: GPS_MINE_ACCURACY_THRESHOLD_M,
    })
    return
  }

  let gpsHex: string | null = null
  try {
    gpsHex = h3.latLngToCell(lat, lon, 11)
  } catch {
    gpsHex = null
  }

  if (!gpsHex) {
    res.json({ ok: false, reason: 'GPS_REQUIRED', balance: user.balance, owned: false })
    return
  }

  if (gpsHex !== h3Index) {
    res.json({ ok: false, reason: 'GPS_MISMATCH', balance: user.balance, owned: false })
    return
  }

  if (user.ownedHexes.has(h3Index)) {
    res.json({
      ok: false,
      reason: 'ALREADY_OWNED',
      balance: user.balance,
      owned: true,
    })
    return
  }

  if (user.balance < SPAWN_COST_GHX) {
    res.json({
      ok: false,
      reason: 'INSUFFICIENT_GHX',
      balance: user.balance,
      owned: false,
    })
    return
  }

  // Deduct spawn cost and mark the hex as owned. For now we treat spawn like a
  // mined hex so that stats continue to work; later we can distinguish types
  // of events if needed.
  user.balance -= SPAWN_COST_GHX
  collectTreasuryFee(SPAWN_COST_GHX)
  user.ownedHexes.add(h3Index)

  miningEvents.push({
    timestamp: Date.now(),
    userId: user.id,
    h3Index,
  })
  saveMiningEvents(miningEvents)
  saveUsers(usersById)

  res.json({
    ok: true,
    balance: user.balance,
    owned: true,
    spawnCost: SPAWN_COST_GHX,
  })
})

// Mining endpoint: marks a hex as mined for the demo user and increases balance by 1
// if this is the first time it is mined for this user.
app.post('/api/mine', requireAuth, (req, res) => {
  const user = (req as express.Request & { user?: User }).user
  if (!user) {
    res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' })
    return
  }

  const { h3Index, lat, lon, accuracyM, gpsAt } = req.body as {
    h3Index?: string
    lat?: number
    lon?: number
    accuracyM?: number
    gpsAt?: number
  }

  if (!h3Index || typeof h3Index !== 'string') {
    res.status(400).json({ ok: false, error: 'INVALID_H3_INDEX' })
    return
  }

  // GPS verification temporarily disabled for testing
  const alreadyOwned = user.ownedHexes.has(h3Index)

  if (alreadyOwned) {
    res.json({
      ok: false,
      reason: 'ALREADY_MINED',
      balance: user.balance,
      owned: true,
    })
    return
  }

  // Check if hex is owned by another user
  const globalOwned = buildGlobalOwnedHexesSet()
  if (globalOwned.has(h3Index)) {
    res.json({
      ok: false,
      reason: 'OWNED_BY_OTHER',
      balance: user.balance,
      owned: false,
    })
    return
  }

  // Safety rule: forbid mining on COAST and in a persisted buffer around
  // detected coastlines (legal/safety protection).
  if (coastBufferHexes.has(h3Index)) {
    res.json({
      ok: false,
      reason: 'FORBIDDEN_ZONE',
      zoneType: 'COAST',
      balance: user.balance,
      owned: false,
    })
    return
  }

  // Frontier rule temporarily disabled for testing
  user.ownedHexes.add(h3Index)
  user.balance += 1

  miningEvents.push({
    timestamp: Date.now(),
    userId: user.id,
    h3Index,
  })
  saveMiningEvents(miningEvents)

  saveUsers(usersById)

  res.json({
    ok: true,
    balance: user.balance,
    owned: true,
  })
})

// Heavier endpoint used only on explicit user interaction (click on a hex).
// This tries Overpass once for the given hex and falls back on error.
app.get('/api/hex/:h3Index/osm', async (req, res) => {
  const { h3Index } = req.params

  let zoneType: ZoneType
  let debug: string[] = []
  let hasRoad: boolean | undefined
  let roadClass: string | undefined

  try {
    const inferred = await inferZoneTypeFromOverpass(h3Index)
    const coastAware = applyCoastBufferFromCache(h3Index, inferred)
    zoneType = coastAware.zoneType
    debug = coastAware.debug
    hasRoad = inferred.hasRoad
    roadClass = inferred.roadClass
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
    hasRoad,
    roadClass,
  }

  res.json(result)
})

// Admin endpoint: Reset all mined hexes for all users (development/testing only)
app.post('/api/admin/reset-hexes', requireAuth, (req, res) => {
  const user = (req as express.Request & { user?: User }).user
  if (!user) {
    res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' })
    return
  }

  // Reset ownedHexes for all users (keep only default start hex)
  let resetCount = 0
  for (const u of usersById.values()) {
    const beforeCount = u.ownedHexes.size
    u.ownedHexes = new Set<string>([DEFAULT_START_HEX])
    if (beforeCount > 1) {
      resetCount++
    }
  }

  saveUsers(usersById)

  res.json({
    ok: true,
    message: 'All mined hexes reset',
    usersReset: resetCount,
    defaultHex: DEFAULT_START_HEX,
  })
})

// Serve static files from dist directory (built frontend)
// This must be after all API routes
const distPath = path.join(__dirname, '..', 'dist')
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath))
  // Serve index.html for all non-API routes (SPA routing)
  app.use((req, res, next) => {
    // Skip API routes
    if (req.path.startsWith('/api/')) {
      return next()
    }
    const indexPath = path.join(distPath, 'index.html')
    if (fs.existsSync(indexPath)) {
      res.sendFile(indexPath)
    } else {
      res.json({ ok: true, service: 'world-hex-miner-api', note: 'Frontend not built yet' })
    }
  })
}

app.listen(port, '0.0.0.0', () => {
  console.log(`Backend listening on http://localhost:${port}`)
  console.log(`Network: http://10.0.0.14:${port}`)
})
