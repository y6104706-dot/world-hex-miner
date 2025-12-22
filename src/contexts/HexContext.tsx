import { createContext, useContext, useState, useRef, type ReactNode } from 'react'
import type { HexFeature, HexInfo } from '../types/hex'
import type { OwnershipState } from '../hooks/useOwnership'

interface HexContextValue {
  // State
  features: HexFeature[]
  ownership: OwnershipState
  selectedHex: string | null
  gpsHex: string | null
  
  // Actions
  setFeatures: (features: HexFeature[]) => void
  setOwnership: (ownership: OwnershipState | ((prev: OwnershipState) => OwnershipState)) => void
  setSelectedHex: (hex: string | null) => void
  setGpsHex: (hex: string | null) => void
  
  // Helpers
  addOwnedHex: (hex: string) => void
  removeOwnedHex: (hex: string) => void
  updateHexOwnership: (hex: string, isOwned: boolean, isMine: boolean) => void
  
  // Cache
  hexInfoCache: Map<string, HexInfo>
}

const HexContext = createContext<HexContextValue | null>(null)

export function HexProvider({ children }: { children: ReactNode }) {
  const [features, setFeatures] = useState<HexFeature[]>([])
  const [ownership, setOwnershipState] = useState<OwnershipState>({
    ownedHexes: new Set(),
    globalOwnedHexes: new Set(),
  })
  const [selectedHex, setSelectedHex] = useState<string | null>(null)
  const [gpsHex, setGpsHex] = useState<string | null>(null)
  const hexInfoCacheRef = useRef<Map<string, HexInfo>>(new Map())

  const addOwnedHex = (hex: string) => {
    setOwnershipState((prev) => {
      const newOwned = new Set(prev.ownedHexes)
      newOwned.add(hex)
      const newGlobal = new Set(prev.globalOwnedHexes)
      newGlobal.add(hex)
      return {
        ownedHexes: newOwned,
        globalOwnedHexes: newGlobal,
      }
    })
  }

  const removeOwnedHex = (hex: string) => {
    setOwnershipState((prev) => {
      const newOwned = new Set(prev.ownedHexes)
      newOwned.delete(hex)
      return {
        ownedHexes: newOwned,
        globalOwnedHexes: prev.globalOwnedHexes, // Keep in global for others
      }
    })
  }

  const updateHexOwnership = (hex: string, isOwned: boolean, isMine: boolean) => {
    setOwnershipState((prev) => {
      const newOwned = new Set(prev.ownedHexes)
      const newGlobal = new Set(prev.globalOwnedHexes)
      
      if (isOwned) {
        newGlobal.add(hex)
        if (isMine) {
          newOwned.add(hex)
        }
      } else {
        newOwned.delete(hex)
        // Don't remove from global - it might be owned by others
      }
      
      return {
        ownedHexes: newOwned,
        globalOwnedHexes: newGlobal,
      }
    })
  }

  const value: HexContextValue = {
    features,
    ownership,
    selectedHex,
    gpsHex,
    setFeatures,
    setOwnership: setOwnershipState,
    setSelectedHex,
    setGpsHex,
    addOwnedHex,
    removeOwnedHex,
    updateHexOwnership,
    hexInfoCache: hexInfoCacheRef.current,
  }

  return <HexContext.Provider value={value}>{children}</HexContext.Provider>
}

export function useHexContext() {
  const context = useContext(HexContext)
  if (!context) {
    throw new Error('useHexContext must be used within HexProvider')
  }
  return context
}

