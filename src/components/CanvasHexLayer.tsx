import { useEffect, useRef } from 'react'
import maplibregl from 'maplibre-gl'
import type { HexFeature } from '../types/hex'
// import { hexToMapLibreCoords } from '../utils/hexUtils' // Unused

interface CanvasHexLayerProps {
  map: maplibregl.Map | null
  features: HexFeature[]
  veinsFeatures?: HexFeature[]
}

/**
 * Canvas-based hex layer - draws hexes directly on canvas for full control over colors
 * This bypasses MapLibre's expression system and gives us direct pixel control
 */
export function CanvasHexLayer({ map, features, veinsFeatures = [] }: CanvasHexLayerProps) {
  console.log('[CanvasHexLayer] Component rendered, map:', !!map, 'features:', features.length, 'veins:', veinsFeatures.length)
  
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const animationFrameRef = useRef<number | null>(null)

  // Initialize canvas overlay
  useEffect(() => {
    console.log('[CanvasHexLayer] useEffect triggered, map:', !!map, 'isStyleLoaded:', map?.isStyleLoaded())
    if (!map) {
      console.log('[CanvasHexLayer] No map, returning')
      return
    }

    // Wait for map to be ready, then create canvas
    const initCanvas = () => {
      if (!map.isStyleLoaded()) {
        console.log('[CanvasHexLayer] Map not loaded yet, waiting...')
        map.once('load', initCanvas)
        return
      }

      console.log('[CanvasHexLayer] Map is loaded, initializing canvas...')

      // Create container for canvas
      if (!containerRef.current) {
      const container = document.createElement('div')
      container.style.position = 'absolute'
      container.style.top = '0'
      container.style.left = '0'
      container.style.width = '100%'
      container.style.height = '100%'
      container.style.pointerEvents = 'none' // Don't block map interactions
      container.style.zIndex = '1000' // Above map, below UI
      map.getContainer().appendChild(container)
      containerRef.current = container
      console.log('[CanvasHexLayer] Canvas container created')
    }

    // Create canvas
    if (!canvasRef.current) {
      const canvas = document.createElement('canvas')
      canvas.style.width = '100%'
      canvas.style.height = '100%'
      canvas.style.display = 'block'
      canvas.style.display = 'block'
      containerRef.current.appendChild(canvas)
      canvasRef.current = canvas

      // Set canvas size to match map container
      const resizeCanvas = () => {
        if (canvas && map) {
          const container = map.getContainer()
          canvas.width = container.clientWidth
          canvas.height = container.clientHeight
        }
      }
      resizeCanvas()
      window.addEventListener('resize', resizeCanvas)
      console.log('[CanvasHexLayer] Canvas created, size:', canvas.width, 'x', canvas.height)
      
      // Also resize when map loads
      map.on('load', resizeCanvas)
      }
    }

    // Start initialization
    initCanvas()

    return () => {
      if (containerRef.current && map) {
        try {
          map.getContainer().removeChild(containerRef.current)
        } catch (e) {
          // Ignore
        }
      }
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current)
      }
    }
  }, [map])

  // Draw hexes on canvas
  useEffect(() => {
    console.log('[CanvasHexLayer] Draw useEffect triggered, map:', !!map, 'canvas:', !!canvasRef.current, 'features:', features.length)
    if (!map || !canvasRef.current) {
      console.log('[CanvasHexLayer] Missing map or canvas, returning')
      return
    }

    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const draw = () => {
      // Clear canvas
      ctx.clearRect(0, 0, canvas.width, canvas.height)

      console.log('[CanvasHexLayer] Drawing', features.length, 'features,', veinsFeatures.length, 'veins')

      // Draw veins first (all owned hexes globally)
      veinsFeatures.forEach((feature) => {
        const coords = feature.geometry.coordinates[0] as [number, number][]
        drawHex(ctx, map, coords, {
          fillColor: feature.properties.isMine ? '#00FF00' : '#00008B',
          fillOpacity: 0.75,
          strokeColor: feature.properties.isMine ? '#00FF00' : '#00008B',
          strokeWidth: 1.5,
        })
      })

      // Draw main hexes (current viewport)
      let mineCount = 0
      let othersCount = 0
      features.forEach((feature) => {
        const coords = feature.geometry.coordinates[0] as [number, number][]
        
        if (feature.properties.isMine) mineCount++
        if (feature.properties.isOthers) othersCount++
        
        let fillColor = '#3388ff' // Default: light blue for unclaimed
        let fillOpacity = 0.25
        let strokeColor = '#888888'
        let strokeWidth = 1

        if (feature.properties.selected) {
          fillColor = '#FFD700' // Gold for selected (GPS location)
          fillOpacity = 0.9
          strokeColor = '#FFD700'
          strokeWidth = 3
        } else if (feature.properties.isMine) {
          fillColor = '#00FF00' // Green for my hexes (mined)
          fillOpacity = 0.85
          strokeColor = '#00FF00'
          strokeWidth = 2
        } else if (feature.properties.isOthers) {
          fillColor = '#00008B' // Dark Blue for others' hexes
          fillOpacity = 0.8
          strokeColor = '#00008B'
          strokeWidth = 2
        } else if (feature.properties.canMine) {
          fillColor = '#e5e7eb' // Light gray for mineable
          fillOpacity = 0.3
          strokeColor = '#888888'
          strokeWidth = 1
        }

        drawHex(ctx, map, coords, {
          fillColor,
          fillOpacity,
          strokeColor,
          strokeWidth,
        })
      })
      
      console.log('[CanvasHexLayer] Drew', mineCount, 'mine,', othersCount, 'others hexes')
    }

    // Draw on map move/zoom
    const onMapChange = () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current)
      }
      animationFrameRef.current = requestAnimationFrame(draw)
    }

    map.on('move', onMapChange)
    map.on('zoom', onMapChange)
    map.on('rotate', onMapChange)
    map.on('pitch', onMapChange)

    // Initial draw
    requestAnimationFrame(draw)

    return () => {
      map.off('move', onMapChange)
      map.off('zoom', onMapChange)
      map.off('rotate', onMapChange)
      map.off('pitch', onMapChange)
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current)
      }
    }
  }, [map, features, veinsFeatures])

  return null
}

/**
 * Draw a single hex on canvas
 */
function drawHex(
  ctx: CanvasRenderingContext2D,
  map: maplibregl.Map,
  coords: [number, number][],
  style: {
    fillColor: string
    fillOpacity: number
    strokeColor: string
    strokeWidth: number
  }
) {
  if (coords.length === 0) return

  ctx.beginPath()

  // Project coordinates to screen space
  // coords are [lng, lat] from MapLibre
  const firstPoint = map.project([coords[0][0], coords[0][1]])
  if (!firstPoint || isNaN(firstPoint.x) || isNaN(firstPoint.y)) {
    console.warn('[CanvasHexLayer] Invalid first point:', coords[0])
    return
  }
  ctx.moveTo(firstPoint.x, firstPoint.y)

  for (let i = 1; i < coords.length; i++) {
    const point = map.project([coords[i][0], coords[i][1]])
    if (!point || isNaN(point.x) || isNaN(point.y)) {
      console.warn('[CanvasHexLayer] Invalid point:', coords[i])
      continue
    }
    ctx.lineTo(point.x, point.y)
  }

  ctx.closePath()

  // Fill
  ctx.fillStyle = style.fillColor
  ctx.globalAlpha = style.fillOpacity
  ctx.fill()

  // Stroke
  ctx.strokeStyle = style.strokeColor
  ctx.lineWidth = style.strokeWidth
  ctx.globalAlpha = 0.9
  ctx.stroke()

  // Reset alpha
  ctx.globalAlpha = 1.0
}

