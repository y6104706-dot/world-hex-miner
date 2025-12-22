import { useMemo } from 'react'
import type { HexProperties } from '../types/hex'

export type OwnershipState = {
  ownedHexes: Set<string>
  globalOwnedHexes: Set<string>
}

/**
 * Calculate ownership properties for a hex
 */
export function useOwnership(
  hexIndex: string,
  ownership: OwnershipState
): Pick<HexProperties, 'owner' | 'isMine' | 'isOthers'> {
  return useMemo(() => {
    const isMine = ownership.ownedHexes.has(hexIndex)
    const isOthers = !isMine && ownership.globalOwnedHexes.has(hexIndex)
    const owner: 'mine' | 'others' | null = isMine ? 'mine' : isOthers ? 'others' : null

    return { owner, isMine, isOthers }
  }, [hexIndex, ownership.ownedHexes, ownership.globalOwnedHexes])
}

/**
 * Calculate ownership for multiple hexes
 */
export function calculateOwnershipForHexes(
  hexIndexes: string[],
  ownership: OwnershipState
): Map<string, Pick<HexProperties, 'owner' | 'isMine' | 'isOthers'>> {
  const result = new Map()
  
  for (const hexIndex of hexIndexes) {
    const isMine = ownership.ownedHexes.has(hexIndex)
    const isOthers = !isMine && ownership.globalOwnedHexes.has(hexIndex)
    const owner: 'mine' | 'others' | null = isMine ? 'mine' : isOthers ? 'others' : null
    
    result.set(hexIndex, { owner, isMine, isOthers })
  }
  
  return result
}

