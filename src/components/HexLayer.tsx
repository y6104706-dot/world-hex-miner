import { useEffect, useRef } from 'react'
import maplibregl from 'maplibre-gl'
import type { HexFeature } from '../types/hex'

interface HexLayerProps {
  map: maplibregl.Map | null
  features: HexFeature[]
  veinsFeatures?: HexFeature[] // Optional veins layer (all owned hexes globally)
}

/**
 * HexLayer component - manages hex polygon layers
 * Colors the hex polygons themselves based on ownership:
 * - Gold (#FFD700) for my hexes
 * - Dark Blue (#00008B) for others' hexes  
 * - Orange (#ff9900) for selected/GPS hex
 * - Light blue/gray for unclaimed hexes
 * 
 * Also manages a "veins" layer that shows all globally owned hexes
 */
export function HexLayer({ map, features, veinsFeatures = [] }: HexLayerProps) {
  const sourcesInitializedRef = useRef(false)
  const mapLoadedRef = useRef(false)

  // Wait for map to be fully loaded
  useEffect(() => {
    if (!map) return

    const onMapLoad = () => {
      mapLoadedRef.current = true
      console.log('[HexLayer] Map style loaded')
    }

    if (map.isStyleLoaded()) {
      mapLoadedRef.current = true
      onMapLoad()
    } else {
      map.on('style.load', onMapLoad)
    }

    return () => {
      map.off('style.load', onMapLoad)
    }
  }, [map])

  useEffect(() => {
    if (!map || !mapLoadedRef.current) {
      console.log('[HexLayer] Waiting for map to load...', { hasMap: !!map, isLoaded: mapLoadedRef.current })
      return
    }

    // Initialize sources and layers only once
    if (!sourcesInitializedRef.current) {
      console.log('[HexLayer] Initializing sources and layers')
      
      // Get all existing layers for debugging
      const style = map.getStyle()
      const allLayers = style?.layers || []
      
      // Log all layer IDs for debugging
      console.log('[HexLayer] All map layers:', allLayers.map(l => l.id).slice(0, 20))
      
      // Find building and label layers to understand layer order
      const buildingLayers = allLayers.filter(l => 
        l.id && (l.id.includes('building') || l.id.includes('structure'))
      )
      const labelLayers = allLayers.filter(l => 
        l.id && (l.id.includes('label') || l.id.includes('text') || l.id.includes('symbol'))
      )
      
      console.log('[HexLayer] Building layers:', buildingLayers.map(l => l.id))
      console.log('[HexLayer] Label layers:', labelLayers.map(l => l.id))

      // Add hex polygon source
      if (!map.getSource('h3-hex')) {
        map.addSource('h3-hex', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        })
      }

      // Add veins source (all owned hexes globally) - loaded separately
      if (!map.getSource('h3-veins')) {
        map.addSource('h3-veins', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        })
      }

      // Add layers at the END (above everything) - no beforeId means add at top
      // This ensures hexes are visible above all map layers
      const addLayerAtTop = (layerDef: any) => {
        map.addLayer(layerDef) // No beforeId = add at the end (top of stack)
      }

      // Add veins layer (below main hex layer so main hexes appear on top)
      // Add at the top of the layer stack (above everything)
      if (!map.getLayer('h3-veins-fill')) {
        addLayerAtTop({
          id: 'h3-veins-fill',
          type: 'fill',
          source: 'h3-veins',
          paint: {
            'fill-color': [
              'case',
              ['get', 'isMine'],
              '#FFD700', // Gold for my hexes
              '#00008B', // Dark Blue for others' hexes
            ],
            'fill-opacity': 0.75, // More visible for veins - increased opacity
          },
        })
      }

      // Add veins outline
      if (!map.getLayer('h3-veins-outline')) {
        addLayerAtTop({
          id: 'h3-veins-outline',
          type: 'line',
          source: 'h3-veins',
          paint: {
            'line-color': [
              'case',
              ['get', 'isMine'],
              '#FFD700', // Gold border for my hexes
              '#00008B', // Dark Blue border for others' hexes
            ],
            'line-width': 1.5,
            'line-opacity': 0.8,
          },
        })
      }

      // Add hex fill layer (polygons) - the hexes themselves are colored
      // This layer shows current viewport hexes and appears above veins
      // Add at the top of the layer stack (above everything)
      if (!map.getLayer('h3-hex-fill')) {
        addLayerAtTop({
          id: 'h3-hex-fill',
          type: 'fill',
          source: 'h3-hex',
          paint: {
            'fill-color': [
              'case',
              ['get', 'selected'],
              '#ff9900', // Orange for selected
              ['get', 'isMine'],
              '#FFD700', // Gold for my hexes
              ['get', 'isOthers'],
              '#00008B', // Dark Blue for others' hexes
              ['get', 'canMine'],
              '#e5e7eb', // Light gray for mineable neighbors
              '#3388ff', // Light blue for unclaimed
            ],
            'fill-opacity': [
              'case',
              ['get', 'selected'],
              0.9, // Very visible for selected - increased opacity
              ['get', 'isMine'],
              0.85, // Very visible for my hexes - Gold - increased opacity
              ['get', 'isOthers'],
              0.8, // Very visible for others' hexes - Dark Blue - increased opacity
              ['get', 'canMine'],
              0.3, // Slightly visible for mineable - increased opacity
              0.25, // More visible for unclaimed so we can see the grid - increased opacity
            ],
          },
        })
      }

      // Add hex outline layer - colored borders matching the fill
      // Add at the top of the layer stack (above everything)
      if (!map.getLayer('h3-hex-outline')) {
        addLayerAtTop({
          id: 'h3-hex-outline',
          type: 'line',
          source: 'h3-hex',
          paint: {
            'line-color': [
              'case',
              ['get', 'selected'],
              '#ff9900', // Orange border for selected
              ['get', 'isMine'],
              '#FFD700', // Gold border for my hexes
              ['get', 'isOthers'],
              '#00008B', // Dark Blue border for others' hexes
              '#888888', // Gray border for others
            ],
            'line-width': [
              'case',
              ['get', 'selected'],
              3, // Thicker for selected
              ['any', ['get', 'isMine'], ['get', 'isOthers']],
              2, // Thicker for owned hexes
              1, // Thin for unclaimed
            ],
            'line-opacity': 0.9,
          },
        })
      }

      sourcesInitializedRef.current = true
    }

    // Update veins layer (all owned hexes globally)
    const veinsSource = map.getSource('h3-veins') as maplibregl.GeoJSONSource | undefined
    if (veinsSource) {
      veinsSource.setData({
        type: 'FeatureCollection',
        features: veinsFeatures,
      })
    }

    // Update hex polygon source (current viewport hexes)
    const hexSource = map.getSource('h3-hex') as maplibregl.GeoJSONSource | undefined
    if (hexSource) {
      const mineCount = features.filter(f => f.properties.isMine).length
      const othersCount = features.filter(f => f.properties.isOthers).length
      console.log('[HexLayer] Updating hex source with', features.length, 'features (', mineCount, 'mine,', othersCount, 'others)')
      
      // Debug: Log sample feature properties
      if (features.length > 0) {
        const sample = features[0]
        console.log('[HexLayer] Sample feature properties:', {
          h3Index: sample.properties.h3Index,
          isMine: sample.properties.isMine,
          isOthers: sample.properties.isOthers,
          selected: sample.properties.selected,
          canMine: sample.properties.canMine,
          owner: sample.properties.owner,
        })
        
        // Log a few more samples to see variety
        const mineSample = features.find(f => f.properties.isMine)
        const othersSample = features.find(f => f.properties.isOthers)
        if (mineSample) {
          console.log('[HexLayer] Mine sample:', {
            h3Index: mineSample.properties.h3Index,
            isMine: mineSample.properties.isMine,
            isOthers: mineSample.properties.isOthers,
          })
        }
        if (othersSample) {
          console.log('[HexLayer] Others sample:', {
            h3Index: othersSample.properties.h3Index,
            isMine: othersSample.properties.isMine,
            isOthers: othersSample.properties.isOthers,
          })
        }
      }
      
      hexSource.setData({
        type: 'FeatureCollection',
        features,
      })
      
      // Verify layer exists and is visible
      const fillLayer = map.getLayer('h3-hex-fill')
      const outlineLayer = map.getLayer('h3-hex-outline')
      console.log('[HexLayer] Layers status:', {
        fillLayerExists: !!fillLayer,
        outlineLayerExists: !!outlineLayer,
        fillLayerVisible: fillLayer ? map.getLayoutProperty('h3-hex-fill', 'visibility') !== 'none' : false,
      })
    } else {
      console.warn('[HexLayer] Hex source not found!')
    }

    // Force repaint to ensure colors are applied
    map.triggerRepaint()
  }, [map, features, veinsFeatures])

  return null // This component doesn't render anything
}

