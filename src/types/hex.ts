// Import ZoneType as a type
import type { ZoneType } from '../utils/hexUtils'

// Export interfaces for hex features
export interface HexFeature {
  type: 'Feature'
  properties: HexProperties
  geometry: {
    type: 'Polygon'
    coordinates: [[number, number][]]
  }
}

export interface HexCenterFeature {
  type: 'Feature'
  properties: HexProperties
  geometry: {
    type: 'Point'
    coordinates: [number, number] // [lng, lat]
  }
}

export interface HexProperties {
  h3Index: string
  zoneType: ZoneType
  claimed: boolean
  selected: boolean
  canMine: boolean
  owner: 'mine' | 'others' | null
  isMine: boolean
  isOthers: boolean
  debugInfo?: string[]
}

export interface HexInfo {
  h3Index: string
  zoneType: ZoneType
  debugInfo?: string[]
}

