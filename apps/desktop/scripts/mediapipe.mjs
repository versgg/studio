// MediaPipe (background removal, auto reframe, tracking) runs from files bundled with the app,
// never from the network: its wasm (the ES-module build the analysis worker imports) from
// @mediapipe/tasks-vision, and the models in assets/mediapipe (Apache 2.0, from Google's
// MediaPipe model pages). They go to <renderer out>/mediapipe/{wasm,models}; the renderer
// loads them from ./mediapipe next to its page. For the dev server, copy them into a folder
// Vite serves at /mediapipe (for example src/renderer/public/mediapipe).
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { appRoot } from './esbuild.mjs'

export function copyMediapipe(outDir = join(appRoot, 'dist-renderer', 'mediapipe')) {
  // The package exports its wasm files by name (not its package.json).
  const wasmSrc = dirname(createRequire(join(appRoot, 'package.json')).resolve('@mediapipe/tasks-vision/vision_wasm_module_internal.js'))
  const wasm = join(outDir, 'wasm')
  const models = join(outDir, 'models')
  mkdirSync(wasm, { recursive: true })
  mkdirSync(models, { recursive: true })
  for (const f of ['vision_wasm_module_internal.js', 'vision_wasm_module_internal.wasm']) copyFileSync(join(wasmSrc, f), join(wasm, f))
  const src = join(appRoot, 'assets', 'mediapipe')
  const found = existsSync(src) ? readdirSync(src).filter((f) => f.endsWith('.tflite')) : []
  for (const f of found) copyFileSync(join(src, f), join(models, f))
  if (found.length < 4) console.warn(`desktop: only ${found.length} MediaPipe models in assets/mediapipe (expected 4)`)
}
