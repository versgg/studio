// MediaPipe (Apache 2.0) in a worker, so analysis never blocks the page or the player's draw
// loop. The wasm and the models are bundled with the app (scripts/build.mjs copies them to
// mediapipe/ beside the page); nothing is fetched from the network.
//   person   ImageSegmenter, selfie_segmenter.tflite (people)
//   subject  InteractiveSegmenterLegacy, magic_touch.tflite (whatever is under a point; the point
//            follows the subject's centre from frame to frame)
//   face     FaceDetector, blaze_face_short_range.tflite
//   object   ObjectDetector, efficientdet_lite0.tflite (80 everyday kinds of thing)

import { FaceDetector, ImageSegmenter, InteractiveSegmenterLegacy, ObjectDetector, type MPMask } from '@mediapipe/tasks-vision'

type Req =
  | { id: number; type: 'init'; base: string }
  | { id: number; type: 'segment'; method: 'person' | 'subject'; width: number; height: number; rgba: ArrayBuffer; point?: { x: number; y: number } }
  | { id: number; type: 'detect'; kind: 'face' | 'object'; width: number; height: number; rgba: ArrayBuffer }
  | { id: number; type: 'reset' }

let base = ''
let clock = 0
const tasks: { person?: ImageSegmenter; subject?: InteractiveSegmenterLegacy; face?: FaceDetector; object?: ObjectDetector } = {}

const loader = () => `${base}/wasm/vision_wasm_module_internal.js`
/**
 * The wasm loader is an ES module: imported once, it sets `ModuleFactory`, which each new
 * task takes and clears. So it's put back before every task is made.
 */
async function fileset() {
  const mod = await import(/* @vite-ignore */ loader())
  ;(self as unknown as { ModuleFactory?: unknown }).ModuleFactory = mod.default
  return { wasmLoaderPath: loader(), wasmBinaryPath: `${base}/wasm/vision_wasm_module_internal.wasm` }
}
const model = (name: string) => ({ modelAssetPath: `${base}/models/${name}`, delegate: 'CPU' as const })

async function person() {
  tasks.person ??= await ImageSegmenter.createFromOptions(await fileset(), { baseOptions: model('selfie_segmenter.tflite'), runningMode: 'VIDEO', outputConfidenceMasks: true, outputCategoryMask: false })
  return tasks.person
}
async function subject() {
  tasks.subject ??= await InteractiveSegmenterLegacy.createFromOptions(await fileset(), { baseOptions: model('magic_touch.tflite'), outputConfidenceMasks: true, outputCategoryMask: false })
  return tasks.subject
}
async function face() {
  tasks.face ??= await FaceDetector.createFromOptions(await fileset(), { baseOptions: model('blaze_face_short_range.tflite'), runningMode: 'VIDEO', minDetectionConfidence: 0.5 })
  return tasks.face
}
async function object() {
  tasks.object ??= await ObjectDetector.createFromOptions(await fileset(), { baseOptions: model('efficientdet_lite0.tflite'), runningMode: 'VIDEO', scoreThreshold: 0.35, maxResults: 8 })
  return tasks.object
}

/** A confidence mask as grey bytes, plus where its weight sits (for the next frame's point). */
function toGrey(mask: MPMask, width: number, height: number) {
  const f = mask.getAsFloat32Array()
  const out = new Uint8Array(width * height)
  let sx = 0
  let sy = 0
  let n = 0
  for (let i = 0; i < out.length; i++) {
    const v = f[i]
    out[i] = v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255)
    if (v > 0.5) {
      sx += i % width
      sy += (i / width) | 0
      n++
    }
  }
  return { grey: out, centre: n ? { x: sx / n / width, y: sy / n / height } : null, area: n / out.length }
}

async function handle(m: Req): Promise<[unknown, Transferable[]]> {
  switch (m.type) {
    case 'init':
      base = m.base.replace(/\/$/, '')
      return [{ ok: true }, []]
    case 'reset':
      // Video-mode tasks need rising timestamps; a fresh job just keeps counting.
      return [{ ok: true }, []]
    case 'segment': {
      const image = new ImageData(new Uint8ClampedArray(m.rgba), m.width, m.height)
      if (m.method === 'person') {
        const seg = await person()
        const r = seg.segmentForVideo(image, (clock += 33))
        const masks = r.confidenceMasks ?? []
        const labels = seg.getLabels().map((l) => l.toLowerCase())
        const at = labels.indexOf('person') >= 0 ? labels.indexOf('person') : masks.length > 1 ? masks.length - 1 : 0
        const out = masks[at] ? toGrey(masks[at], m.width, m.height) : { grey: new Uint8Array(m.width * m.height), centre: null, area: 0 }
        r.close?.()
        return [out, [out.grey.buffer]]
      }
      const seg = await subject()
      const point = m.point ?? { x: 0.5, y: 0.5 }
      const r = seg.segment(image, { keypoint: point })
      const mask = r.confidenceMasks?.[0]
      const out = mask ? toGrey(mask, m.width, m.height) : { grey: new Uint8Array(m.width * m.height), centre: null, area: 0 }
      r.close?.()
      return [out, [out.grey.buffer]]
    }
    case 'detect': {
      const image = new ImageData(new Uint8ClampedArray(m.rgba), m.width, m.height)
      const det = m.kind === 'face' ? await face() : await object()
      const r = det.detectForVideo(image, (clock += 33))
      const found = r.detections.map((d) => {
        const b = d.boundingBox ?? { originX: 0, originY: 0, width: 0, height: 0 }
        const c = d.categories?.[0]
        return { x: b.originX / m.width, y: b.originY / m.height, w: b.width / m.width, h: b.height / m.height, score: c?.score ?? 0, label: m.kind === 'face' ? 'face' : (c?.categoryName ?? 'object') }
      })
      return [found, []]
    }
  }
}

self.onmessage = async (e: MessageEvent<Req>) => {
  const m = e.data
  try {
    const [result, transfer] = await handle(m)
    ;(self as unknown as Worker).postMessage({ id: m.id, result }, transfer)
  } catch (err) {
    ;(self as unknown as Worker).postMessage({ id: m.id, error: (err as Error)?.message ?? String(err) })
  }
}
