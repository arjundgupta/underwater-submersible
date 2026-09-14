'use client'

import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls, PerformanceMonitor } from '@react-three/drei'
import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import * as THREE from 'three'
import { useTheme } from '@/lib/theme'
import { Axis, RovModel } from './RovModel'

/** Native resolution, capped — the ceiling adaptive quality climbs back to. */
const DPR_CAP = () => Math.min(typeof window !== 'undefined' ? window.devicePixelRatio : 1.5, 2)

export type Insets = { left?: number; right?: number; top?: number; bottom?: number }

/**
 * Keeps the machine inside its frame, whatever it is doing.
 *
 * Orthographic zoom is pixels-per-world-unit, so framing is a division rather
 * than a dolly. Rather than guessing a fixed extent, this measures the machine
 * every frame — each part's own bounding box, carried through the part's
 * transform straight into camera space — so it adapts as parts separate and as
 * the viewer rotates it, and nothing can slide off the edge. Parallel
 * projection is what keeps the machine reading as a measurable object rather
 * than a photograph of one.
 *
 * Part by part, and in camera space, because the alternative is loose. The fit
 * used to box the whole group in world axes and project that box's corners; a
 * long body seen from the oblique default angle sat inside a box half again as
 * wide and nearly twice as tall as what was drawn, and the framing had to be
 * pushed 40% past the fit to close the gap — a number tuned to one angle and
 * wrong at every other. A part's own box hugs the part however the machine is
 * turned, and the union of those sits within a few percent of the silhouette
 * across the screen, so the fit can simply be a fit.
 */

/**
 * Air around the machine, as a factor on its measured extent.
 *
 * Small, because the clear area already stands off the interface by a gap of
 * its own (see the insets measured in Console), and because what is framed
 * here is close to the real silhouette rather than a loose box around it. At
 * 1.04 the machine takes 96% of the clear width; the rest is the gap and a
 * little more.
 */
const MARGIN = 1.04

/**
 * Extra push when something has been switched off.
 *
 * Stripping the shell away does not shrink what is drawn by much — the tube
 * and the chassis inside it run nearly the full length of the hull — so a
 * plain fit would answer LOOK INSIDE with the same picture and less in it.
 * Asking to see the interior is asking to see it closer, so the frame closes
 * in on what is left.
 *
 * Exactly the margin, no more: that spends the air the fit leaves around the
 * machine and stops at the edge of the clear area, so the interior grows into
 * the gap beside the instruments and the index and never under them.
 */
const REVEAL_FILL = MARGIN

function Frame({
  target,
  insets,
  scale,
  revealed,
}: {
  target: MutableRefObject<THREE.Group | null>
  /** Screen-space regions the model must keep out of, in CSS pixels. */
  insets?: Insets
  /** The viewer's zoom, multiplied onto the fitted zoom. */
  scale: MutableRefObject<number>
  /** True once anything has been switched off — see REVEAL_FILL. */
  revealed?: boolean
}) {
  const { camera, size } = useThree()
  const corner = useMemo(() => new THREE.Vector3(), [])
  const toCamera = useMemo(() => new THREE.Matrix4(), [])
  const settled = useRef(false)
  const lastZoom = useRef(-1)
  const lastOffset = useRef({ x: Infinity, y: Infinity })

  useFrame((_, delta) => {
    const group = target.current
    if (!group) return

    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity

    // Hidden parts are unmounted rather than switched off, but the visible
    // walk is the right one regardless: the frame fits what is drawn.
    group.updateWorldMatrix(true, true)
    group.traverseVisible((object) => {
      const geometry = (object as THREE.Mesh).geometry as THREE.BufferGeometry | undefined
      if (!geometry) return
      // Cached on the geometry, so each part pays for this once.
      if (geometry.boundingBox === null) geometry.computeBoundingBox()
      const bounds = geometry.boundingBox
      if (!bounds || bounds.isEmpty()) return

      toCamera.multiplyMatrices(camera.matrixWorldInverse, object.matrixWorld)
      for (let i = 0; i < 8; i++) {
        corner
          .set(
            i & 1 ? bounds.max.x : bounds.min.x,
            i & 2 ? bounds.max.y : bounds.min.y,
            i & 4 ? bounds.max.z : bounds.min.z,
          )
          .applyMatrix4(toCamera)
        minX = Math.min(minX, corner.x)
        maxX = Math.max(maxX, corner.x)
        minY = Math.min(minY, corner.y)
        maxY = Math.max(maxY, corner.y)
      }
    })
    if (minX === Infinity) return

    const width = (maxX - minX) * MARGIN
    const height = (maxY - minY) * MARGIN
    if (width <= 0 || height <= 0) return

    // Fit into what the interface leaves free, not the whole canvas. The canvas
    // stays full-bleed so the machine still reads as the page, but it is sized
    // and centred inside the clear area so nothing is ever drawn under the
    // chrome laid over it.
    const left = insets?.left ?? 0
    const right = insets?.right ?? 0
    const top = insets?.top ?? 0
    const bottom = insets?.bottom ?? 0
    const availWidth = Math.max(120, size.width - left - right)
    const availHeight = Math.max(120, size.height - top - bottom)

    const fill = revealed ? REVEAL_FILL : 1
    const wanted = Math.min(availWidth / width, availHeight / height) * scale.current * fill
    /*
     * Quick to back off, unhurried to close in.
     *
     * The stack opens with the same time constant the zoom used to follow it
     * with, and a follower that lags what it follows leaves the parts running
     * past the clear area — into the header and the footer — for the whole
     * length of the animation, by a fifth at its worst. So the zoom is never
     * allowed above the fit: backing off tracks the bound exactly, which is
     * smooth because the bound itself moves smoothly, and only closing in is
     * damped, which is the direction where the ease is actually seen.
     */
    camera.zoom = settled.current
      ? Math.min(wanted, THREE.MathUtils.damp(camera.zoom, wanted, 3.2, delta))
      : wanted

    // Shift the projection so the free area's centre, not the canvas centre, is
    // where the machine's origin sits. A positive view offset looks further
    // right/down into the frustum, which moves what you see the other way —
    // hence negated, below.
    let shiftX = (left - right) / 2
    let shiftY = (top - bottom) / 2

    /*
     * Then nudge it, but only as far as it has to go.
     *
     * The machine is not symmetric about its own origin once it comes apart —
     * the stack reaches further one way than the other — so a stack that fits
     * the clear area in size still ran out through the top of it. Centring
     * the measured bound outright would fix that, and would also pin the
     * machine dead still: the idle bob that reads as it hanging in water is
     * cancelled by a frame that follows it. So the frame moves only when the
     * bound would otherwise leave the clear area, by exactly the overhang, and
     * otherwise leaves the machine where it drifts. Screen space here, pixels
     * from the canvas centre, y down; the air is the margin's share of the
     * slack, so the nudge keeps it rather than pushing flush to the edge.
     */
    const zoom = camera.zoom
    const airX = ((MARGIN - 1) * (maxX - minX) * zoom) / 2
    const airY = ((MARGIN - 1) * (maxY - minY) * zoom) / 2
    const boundLeft = minX * zoom + shiftX
    const boundRight = maxX * zoom + shiftX
    const boundTop = -maxY * zoom + shiftY
    const boundBottom = -minY * zoom + shiftY
    const areaLeft = -size.width / 2 + left + airX
    const areaRight = size.width / 2 - right - airX
    const areaTop = -size.height / 2 + top + airY
    const areaBottom = size.height / 2 - bottom - airY
    // Stateless: measured from the base shift every frame, never from the last
    // nudge, so it cannot hunt. On the binding axis the bound and the aired
    // area are the same size to within rounding, and the top or left edge is
    // simply the one that wins.
    if (boundLeft < areaLeft) shiftX += areaLeft - boundLeft
    else if (boundRight > areaRight) shiftX += areaRight - boundRight
    if (boundTop < areaTop) shiftY += areaTop - boundTop
    else if (boundBottom > areaBottom) shiftY += areaBottom - boundBottom

    // To the quarter pixel: the machine breathes, and the nudge would
    // otherwise move by a hair every frame and rebuild the projection for it.
    const offsetChanged =
      Math.abs(shiftX - lastOffset.current.x) > 0.25 ||
      Math.abs(shiftY - lastOffset.current.y) > 0.25
    if (offsetChanged) {
      lastOffset.current.x = shiftX
      lastOffset.current.y = shiftY
      if (shiftX || shiftY) {
        camera.setViewOffset(size.width, size.height, -shiftX, -shiftY, size.width, size.height)
      } else if (camera.view?.enabled) {
        camera.clearViewOffset()
      }
    }

    settled.current = true

    /*
     * Only rebuild the projection when it would actually differ.
     *
     * The machine breathes, so the fitted zoom is never perfectly still — but
     * it settles to within a rounding error of its target and then sits there.
     * Recomputing the matrix on every one of those frames re-uploads the
     * camera uniforms for a change too small to see. Below a thousandth of a
     * unit of zoom, leave it alone.
     */
    if (offsetChanged || Math.abs(camera.zoom - lastZoom.current) > 1e-3) {
      lastZoom.current = camera.zoom
      camera.updateProjectionMatrix()
    }
  })

  return null
}

export function RovCanvas({
  explode,
  hidden,
  insets,
  zoom,
  resetSignal = 0,
  hotPart,
  onHoverPart,
  onSelectPart,
  active = true,
}: {
  explode: MutableRefObject<number>
  hidden?: ReadonlySet<string>
  insets?: Insets
  /** Viewer zoom multiplier, 1 = fitted. */
  zoom?: number
  /** Changing this number returns the camera to its default angle. */
  resetSignal?: number
  hotPart?: string | null
  onHoverPart?: (id: string | null) => void
  onSelectPart?: (id: string) => void
  /** False while the section is off screen — the render loop stops dead. */
  active?: boolean
}) {
  const theme = useTheme()
  const model = useRef<THREE.Group>(null)
  const controls = useRef<OrbitControlsImpl>(null)
  const scale = useRef(1)

  // Adaptive quality: render at native resolution, and if the GPU cannot hold
  // frame rate, trade pixels — never geometry. The model stays exactly the
  // model; a struggling machine just gets a slightly softer canvas.
  const [dpr, setDpr] = useState(DPR_CAP)

  /**
   * True while the viewer is dragging. The model's idle drift reads as the
   * machine hanging in water, but it fights the hand that is trying to hold
   * it still — so it stands down for as long as anyone is steering.
   */
  const steering = useRef(false)

  scale.current = zoom ?? 1

  useEffect(() => {
    if (resetSignal > 0) controls.current?.reset()
  }, [resetSignal])

  return (
    <Canvas
      orthographic
      // The camera sits ~12.4 units out and the exploded stack reaches ~11, so
      // this spans the scene with room to orbit and nothing to spare. A loose
      // range here is not free: the depth buffer is shared across it, and at
      // 600 units the machine occupied 1% of it and z-fought with its own
      // internals showing through the shell.
      camera={{ position: [7, 4.6, 9], zoom: 80, near: 0.1, far: 46 }}
      dpr={dpr}
      frameloop={active ? 'always' : 'never'}
      gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
      style={{ width: '100%', height: '100%' }}
    >
      <PerformanceMonitor
        onDecline={() => setDpr((d) => Math.max(1, +(d - 0.5).toFixed(2)))}
        onIncline={() => setDpr((d) => Math.min(DPR_CAP(), +(d + 0.25).toFixed(2)))}
        flipflops={3}
        onFallback={() => setDpr(1)}
      />
      {/*
        Three-point lighting, warm key against cool fill, plus a rim to lift
        the silhouette off a near-black page. No environment map: it would mean
        fetching an HDR from a CDN, and this reads cleanly without one.
      */}
      {/*
        Less light on the print, not more — the whole rig, not just the fill.
        
        Two things go wrong on cream at the negative's exposure. An off-white
        hull on warm cream is two near-identical values, so what separates the
        machine from the page is its own shading, and lifting the ambient
        washes exactly that out. And every coloured part — the maroon
        autopilot case, the green boards, the cells — sits blown out at the top
        of the tone curve, where a surface has nowhere left to go but white.
        On near-black that reads as bright; on cream it reads as faded, and
        the CAD's own colours stop coming through.

        So the print is exposed about a third of a stop down across the board.
        Nothing about the model changes — it is lit less hard, and the colour
        that was always in the material gets somewhere to sit.
      */}
      {(() => {
        const print = theme === 'light'
        return (
          <>
            <ambientLight intensity={print ? 0.3 : 0.55} color="#8fb4d6" />
            <directionalLight position={[6, 9, 7]} intensity={print ? 1.85 : 2.6} color="#fff4e2" />
            <directionalLight position={[-7, 3, -5]} intensity={print ? 0.78 : 1.1} color="#7fb2e0" />
            <directionalLight position={[-2, -6, 4]} intensity={print ? 0.36 : 0.5} color="#a3d5f7" />
          </>
        )
      })()}

      {/* Measured for framing; the centreline sits outside so it can run past
          the machine without dragging the camera back with it. */}
      <group ref={model}>
        <RovModel
          explode={explode}
          hidden={hidden}
          steering={steering}
          hotPart={hotPart}
          onHoverPart={onHoverPart}
          onSelectPart={onSelectPart}
        />
      </group>
      <Axis explode={explode} ink={theme === 'light' ? '#1b1712' : '#f2efe1'} />
      <Frame
        target={model}
        insets={insets}
        scale={scale}
        revealed={(hidden?.size ?? 0) > 0}
      />

      <OrbitControls
        ref={controls}
        makeDefault
        enablePan={false}
        // Wheel zoom would swallow the page scroll on a full-bleed canvas, so
        // zoom is driven by the on-screen controls instead.
        enableZoom={false}
        enableDamping
        dampingFactor={0.07}
        rotateSpeed={0.45}
        minPolarAngle={Math.PI * 0.12}
        maxPolarAngle={Math.PI * 0.86}
        onStart={() => {
          steering.current = true
        }}
        onEnd={() => {
          steering.current = false
        }}
      />
    </Canvas>
  )
}
