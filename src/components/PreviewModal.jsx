import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { OutlineEffect } from 'three/examples/jsm/effects/OutlineEffect.js'
import * as lamejs from '@breezystack/lamejs'
import api from '../api.js'
import Icon from './Icon.jsx'
import AudioPlayer from './AudioPlayer.jsx'
import { Modal, useToast } from './ui.jsx'

function toBytes (value) {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (Array.isArray(value?.data)) return Uint8Array.from(value.data)
  throw new Error('The file data could not be read.')
}

// Encode a decoded preview WAV as MP3 in the renderer (192 kbps).
async function encodeMp3 (url) {
  const asset = await api.readPreviewAsset(url)
  const bytes = toBytes(asset.bytes)
  const ctx = new AudioContext()
  let decoded
  try {
    decoded = await ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
  } finally {
    ctx.close()
  }
  const channels = Math.min(2, decoded.numberOfChannels)
  const toInt16 = data => {
    const out = new Int16Array(data.length)
    for (let i = 0; i < data.length; i++) {
      const s = Math.max(-1, Math.min(1, data[i]))
      out[i] = s < 0 ? s * 32768 : s * 32767
    }
    return out
  }
  const left = toInt16(decoded.getChannelData(0))
  const right = channels === 2 ? toInt16(decoded.getChannelData(1)) : null
  const encoder = new lamejs.Mp3Encoder(channels, decoded.sampleRate, 192)
  const chunks = []
  for (let i = 0; i < left.length; i += 1152) {
    const l = left.subarray(i, i + 1152)
    const part = channels === 2 ? encoder.encodeBuffer(l, right.subarray(i, i + 1152)) : encoder.encodeBuffer(l)
    if (part.length) chunks.push(new Uint8Array(part))
  }
  const tail = encoder.flush()
  if (tail.length) chunks.push(new Uint8Array(tail))
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length }
  return out
}

// Stepped gradient shared by every toon material.
function makeGradientMap () {
  const steps = new Uint8Array([96, 160, 218, 255])
  const texture = new THREE.DataTexture(steps, steps.length, 1, THREE.RedFormat)
  texture.minFilter = THREE.NearestFilter
  texture.magFilter = THREE.NearestFilter
  texture.needsUpdate = true
  return texture
}

function ModelViewer ({ model }) {
  const host = useRef(null)
  const runtime = useRef(null)
  const [error, setError] = useState('')
  const [stats, setStats] = useState(null)
  const [skeleton, setSkeleton] = useState(false)

  useEffect(() => {
    if (!host.current || !model) return
    setError(''); setStats(null); setSkeleton(false)
    const el = host.current
    const scene = new THREE.Scene(); scene.background = new THREE.Color(0x131316)
    const camera = new THREE.PerspectiveCamera(42, el.clientWidth / Math.max(1, el.clientHeight), 0.01, 2000)
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1)); renderer.setSize(el.clientWidth, el.clientHeight)
    renderer.outputColorSpace = THREE.SRGBColorSpace
    el.appendChild(renderer.domElement)
    const outline = new OutlineEffect(renderer, { defaultThickness: 0.0032, defaultColor: [0.02, 0.02, 0.03], defaultAlpha: 0.85 })

    scene.add(new THREE.HemisphereLight(0xffffff, 0x3d3d46, 2.6))
    const key = new THREE.DirectionalLight(0xfff6dd, 2.6); key.position.set(4, 7, 5); scene.add(key)
    const fill = new THREE.DirectionalLight(0xcfe6ff, 0.7); fill.position.set(-5, 3, -4); scene.add(fill)
    scene.add(new THREE.GridHelper(20, 20, 0x3a3a42, 0x232329))

    const controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = true
    const clock = new THREE.Clock()
    const gradientMap = makeGradientMap()
    let object = null; let mixer = null; let disposed = false
    const textureCache = new Map()
    const disposables = new Set()

    const loadTexture = async (url, colorTexture = false) => {
      if (!url) return null
      if (!textureCache.has(url)) {
        textureCache.set(url, (async () => {
          const asset = await api.readPreviewAsset(url)
          const bitmap = await createImageBitmap(new Blob([toBytes(asset.bytes)], { type: asset.mime || 'image/png' }))
          const texture = new THREE.Texture(bitmap); texture.flipY = false; texture.needsUpdate = true
          texture.wrapS = THREE.RepeatWrapping; texture.wrapT = THREE.RepeatWrapping
          if (colorTexture) texture.colorSpace = THREE.SRGBColorSpace
          return texture
        })())
      }
      return textureCache.get(url)
    }

    // Apply FModel texture metadata to the imported materials. Material names
    // are matched case-insensitively, and the white fallback only applies when
    // a diffuse texture actually loaded.
    const applyModelMaterials = async loaded => {
      const infoByName = new Map(Object.entries(model.materials || {}).map(([name, info]) => [name.toLowerCase(), info]))
      const meshMaterials = new Set()
      loaded.traverse(child => {
        if (!child.isMesh) return
        const materials = Array.isArray(child.material) ? child.material : [child.material]
        materials.filter(Boolean).forEach(material => meshMaterials.add(material))
      })
      await Promise.all([...meshMaterials].map(async material => {
        const info = infoByName.get(String(material.name || '').toLowerCase())
        material.vertexColors = false
        if (!info) { material.color?.set?.(0x9aa1ac); material.needsUpdate = true; return }
        try {
          const [diffuse, normal, emissive, opacity] = await Promise.all([
            loadTexture(info.diffuse, true), loadTexture(info.normal), loadTexture(info.emissive, true), loadTexture(info.opacity)
          ])
          material.color?.set?.(diffuse ? 0xffffff : 0x9aa1ac)
          if (diffuse) material.map = diffuse
          if (normal) { material.normalMap = normal; material.normalScale?.set?.(1, -1) }
          if (emissive) { material.emissiveMap = emissive; material.emissive?.set?.(0xffffff); material.emissiveIntensity = 1 }
          if (opacity) material.alphaMap = opacity
          if (info.color && diffuse == null) {
            const r = Number(info.color.R ?? info.color.r); const g = Number(info.color.G ?? info.color.g); const b = Number(info.color.B ?? info.color.b)
            if ([r, g, b].every(Number.isFinite) && (r + g + b) / 3 > 0.02) material.color?.setRGB?.(r, g, b, THREE.LinearSRGBColorSpace)
          }
          if (info.blendMode === 1) material.alphaTest = 0.3333
          if (info.blendMode > 1) { material.transparent = true; material.opacity = 0.68; material.depthWrite = false }
          if (info.twoSided || /hair|eyelash|fur/i.test(material.name)) material.side = THREE.DoubleSide
          material.needsUpdate = true
        } catch { material.color?.set?.(0x9aa1ac); material.needsUpdate = true }
      }))
    }

    // The one and only render mode: cel shading with ink outlines.
    const convertToToon = loaded => {
      loaded.traverse(child => {
        if (!child.isMesh) return
        const source = Array.isArray(child.material) ? child.material : [child.material]
        const toon = source.map(m => {
          disposables.add(m)
          const converted = new THREE.MeshToonMaterial({
            color: m.color ? m.color.clone() : new THREE.Color(0xffffff),
            map: m.map || null,
            normalMap: m.normalMap || null,
            emissive: m.emissive ? m.emissive.clone() : new THREE.Color(0x000000),
            emissiveMap: m.emissiveMap || null,
            emissiveIntensity: m.emissiveIntensity ?? 1,
            alphaMap: m.alphaMap || null,
            transparent: !!m.transparent,
            opacity: m.opacity ?? 1,
            alphaTest: m.alphaTest || 0,
            side: m.side ?? THREE.FrontSide,
            gradientMap
          })
          converted.depthWrite = m.depthWrite !== false
          converted.name = m.name
          disposables.add(converted)
          return converted
        })
        child.material = Array.isArray(child.material) ? toon : toon[0]
      })
    }

    const fit = (loaded, animations = []) => {
      if (disposed) return
      object = loaded
      // Exported skeletons can rest in a different axis space than the skinned
      // mesh; snapping bones to the bind pose lines the skeleton up with the
      // visible model (fixes the upside-down skeleton helper).
      if (animations.length === 0) {
        loaded.traverse(child => {
          if (child.isSkinnedMesh && child.skeleton) { try { child.skeleton.pose() } catch { /* partial rig */ } }
        })
      }
      loaded.updateMatrixWorld(true)
      scene.add(object)
      const box = new THREE.Box3().setFromObject(object); const size = box.getSize(new THREE.Vector3()); const center = box.getCenter(new THREE.Vector3())
      object.position.sub(center); object.position.y += size.y / 2
      const distance = Math.max(size.x, size.y, size.z, 1) * 1.65
      camera.position.set(distance * 0.65, distance * 0.45, distance)
      camera.near = Math.max(distance / 1000, 0.001); camera.far = distance * 100
      camera.updateProjectionMatrix(); controls.target.set(0, size.y * 0.35, 0); controls.update()
      const materialSet = new Set(); let vertices = 0; let triangles = 0; let bones = 0; let skinned = false
      object.traverse(child => {
        if (child.isBone) bones++
        if (child.isSkinnedMesh) skinned = true
        if (!child.isMesh) return
        const geometry = child.geometry; const positionCount = geometry?.attributes?.position?.count || 0
        vertices += positionCount; triangles += Math.floor((geometry?.index?.count || positionCount) / 3)
        const materials = Array.isArray(child.material) ? child.material : [child.material]
        materials.filter(Boolean).forEach(material => materialSet.add(material))
      })
      let skeletonHelper = null
      if (skinned) { skeletonHelper = new THREE.SkeletonHelper(object); skeletonHelper.visible = false; scene.add(skeletonHelper) }
      if (animations.length) { mixer = new THREE.AnimationMixer(object); animations.forEach(clip => mixer.clipAction(clip).play()) }
      setStats({ vertices, triangles, materials: materialSet.size, bones, skinned })
      runtime.current = { skeletonHelper }
    }

    const onError = loadError => { if (!disposed) setError(loadError?.message || 'This model could not be loaded.') }
    const finishGltf = async gltf => {
      await applyModelMaterials(gltf.scene)
      convertToToon(gltf.scene)
      fit(gltf.scene, gltf.animations || [])
    }
    const loadInMemory = async () => {
      try {
        const asset = await api.readPreviewAsset(model.url)
        const bytes = toBytes(asset.bytes)
        if (/\.obj$/i.test(model.name)) {
          const loaded = new OBJLoader().parse(new TextDecoder().decode(bytes))
          await applyModelMaterials(loaded)
          convertToToon(loaded)
          fit(loaded)
          return
        }
        const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
        new GLTFLoader().parse(buffer, '', gltf => finishGltf(gltf).catch(onError), onError)
      } catch (loadError) { onError(loadError) }
    }
    if (/\.(glb|obj)$/i.test(model.name)) loadInMemory()
    else new GLTFLoader().load(model.url, gltf => finishGltf(gltf).catch(onError), undefined, onError)

    let raf
    const animate = () => {
      raf = requestAnimationFrame(animate)
      if (mixer) mixer.update(clock.getDelta())
      controls.update()
      outline.render(scene, camera)
    }
    animate()
    const resize = new ResizeObserver(() => {
      const w = el.clientWidth; const h = Math.max(1, el.clientHeight)
      camera.aspect = w / h; camera.updateProjectionMatrix(); renderer.setSize(w, h)
    })
    resize.observe(el)
    return () => {
      disposed = true; runtime.current = null; cancelAnimationFrame(raf); resize.disconnect(); controls.dispose(); mixer?.stopAllAction(); renderer.dispose(); renderer.domElement.remove()
      gradientMap.dispose()
      object?.traverse(child => { child.geometry?.dispose?.() })
      disposables.forEach(material => { for (const value of Object.values(material)) if (value?.isTexture) value.dispose(); material.dispose?.() })
    }
  }, [model])

  const toggleSkeleton = () => {
    const next = !skeleton
    setSkeleton(next)
    if (runtime.current?.skeletonHelper) runtime.current.skeletonHelper.visible = next
  }

  return (
    <div className="model-canvas">
      <div ref={host} style={{ position: 'absolute', inset: 0 }} />
      {stats?.skinned && (
        <div className="model-controls">
          <button className={skeleton ? 'active' : ''} onClick={toggleSkeleton}>Skeleton</button>
        </div>
      )}
      {stats && <div className="model-stats">{stats.triangles.toLocaleString()} tris · {stats.vertices.toLocaleString()} verts · {stats.materials} materials{stats.bones ? ` · ${stats.bones} bones` : ''}</div>}
      {error && <div className="model-error"><b>Could not display this model</b><span>{error}</span></div>}
    </div>
  )
}

function LoadingBody ({ progress }) {
  const pct = progress && progress.total > 0 && progress.current != null
    ? Math.round((progress.current / progress.total) * 100)
    : null
  return (
    <div className="preview-loading">
      <div className="spinner" style={{ margin: 0 }} />
      <div className="msg">{progress?.message || 'Preparing preview…'}</div>
      <div className={`bar ${pct == null ? 'indet' : ''}`}><div style={{ width: pct != null ? `${pct}%` : '40%' }} /></div>
    </div>
  )
}

export default function PreviewModal ({ data, progress, title = 'Mod Preview', onClose }) {
  const toast = useToast()
  const [selected, setSelected] = useState(null)
  const [menu, setMenu] = useState(null) // { x, y, asset }

  const groups = data
    ? [
        { label: '3D Models', kind: 'model', items: data.models || [] },
        { label: 'Audio', kind: 'audio', items: data.audio || [] },
        { label: 'Textures', kind: 'texture', items: data.images || [] }
      ].filter(g => g.items.length)
    : []

  useEffect(() => {
    if (!data || selected) return
    const first = groups[0]
    if (first) setSelected({ kind: first.kind, item: first.items[0] })
  }, [data]) // eslint-disable-line

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    window.addEventListener('click', close)
    window.addEventListener('contextmenu', close, true)
    return () => { window.removeEventListener('click', close); window.removeEventListener('contextmenu', close, true) }
  }, [menu])

  const openMenu = (event, kind, item) => {
    event.preventDefault()
    event.stopPropagation()
    setSelected({ kind, item })
    setMenu({ x: Math.min(event.clientX, window.innerWidth - 240), y: Math.min(event.clientY, window.innerHeight - 180), kind, item })
  }

  const save = async (url, name) => {
    try {
      const saved = await api.savePreviewAsset(url, name)
      if (saved) toast.ok('Saved', saved)
    } catch (e) { toast.err('Save failed', e.message) }
  }

  const saveOriginals = async item => {
    try {
      const result = await api.exportPreviewAssets(item.originals.map(o => o.url))
      if (result) toast.ok(`${result.copied} file(s) saved`, result.dir)
    } catch (e) { toast.err('Save failed', e.message) }
  }

  const saveMp3 = async item => {
    try {
      toast.info('Encoding MP3…')
      const bytes = await encodeMp3(item.url)
      const saved = await api.savePreviewBytes(item.name.replace(/\.wav$/i, '') + '.mp3', bytes)
      if (saved) toast.ok('Saved', saved)
    } catch (e) { toast.err('MP3 export failed', e.message) }
  }

  const menuActions = menu ? (() => {
    const { kind, item } = menu
    const actions = []
    if (kind === 'model') actions.push({ icon: 'cube', label: 'Export GLB', run: () => save(item.url, item.name) })
    if (kind === 'audio') {
      actions.push({ icon: 'audio', label: 'Export WAV', run: () => save(item.url, item.name) })
      actions.push({ icon: 'audio', label: 'Export MP3', run: () => saveMp3(item) })
    }
    if (kind === 'texture') actions.push({ icon: 'image', label: 'Export PNG', run: () => save(item.url, item.name) })
    if (item.originals?.length) actions.push({ icon: 'package', label: `Save original files (${item.originals.length})`, run: () => saveOriginals(item) })
    return actions
  })() : []

  const empty = data && groups.length === 0

  return (
    <Modal onClose={onClose} width="min(1240px, 96vw)">
      <div className="pv">
        <div className="pv-head">
          <div className="pv-title">{title}</div>
        </div>

        <div className="pv-viewer">
          {!data && <LoadingBody progress={progress} />}
          {empty && (
            <div className="pv-empty">
              <Icon name="package" size={30} />
              <b>Nothing to preview in this mod</b>
              {data.notes?.[0] && <span>{data.notes[0]}</span>}
            </div>
          )}
          {data && selected?.kind === 'model' && <ModelViewer model={selected.item} />}
          {data && selected?.kind === 'texture' && (
            <div className="pv-stage">
              <img src={selected.item.url} alt={selected.item.name} />
              <div className="pv-caption">{selected.item.name}</div>
            </div>
          )}
          {data && selected?.kind === 'audio' && (
            <div className="pv-audio">
              <AudioPlayer
                src={selected.item.url}
                title={selected.item.title || selected.item.name}
                subtitle={[selected.item.hero, selected.item.bankName, selected.item.originalName].filter(Boolean).join(' · ')}
                badge={selected.item.usage || ''}
                onSave={() => save(selected.item.url, selected.item.name)}
              />
            </div>
          )}
        </div>

        {data && !empty && (
          <div className="pv-shelf">
            {groups.map(group => (
              <div className="pv-group" key={group.kind}>
                <div className="pv-group-label">{group.label}</div>
                {group.items.map(item => {
                  const active = selected?.item === item
                  return (
                    <button
                      key={item.url}
                      className={`pv-tile ${active ? 'active' : ''}`}
                      title={`${item.title || item.name}\nRight-click to export`}
                      onClick={() => setSelected({ kind: group.kind, item })}
                      onContextMenu={e => openMenu(e, group.kind, item)}
                    >
                      <span className="th">
                        {group.kind === 'texture'
                          ? <img src={item.url} alt="" loading="lazy" />
                          : <Icon name={group.kind === 'model' ? 'cube' : 'audio'} size={26} />}
                      </span>
                      <span className="nm">{item.title || item.name}</span>
                    </button>
                  )
                })}
              </div>
            ))}
          </div>
        )}
      </div>

      {menu && (
        <div className="ctx-menu" style={{ left: menu.x, top: menu.y }}>
          {menuActions.map(action => (
            <button key={action.label} onClick={() => { setMenu(null); action.run() }}>
              <Icon name={action.icon} size={14} /> {action.label}
            </button>
          ))}
        </div>
      )}
    </Modal>
  )
}
