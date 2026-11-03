import { join } from 'node:path'
import { build as viteBuild } from 'vite'
import { appRoot, buildMainAndPreload } from './esbuild.mjs'
import { copyMediapipe } from './mediapipe.mjs'

await buildMainAndPreload()
await viteBuild({ configFile: join(appRoot, 'vite.config.mts'), logLevel: 'warn' })
// After Vite (it empties dist-renderer): MediaPipe's wasm and models, bundled, not fetched.
copyMediapipe()
console.log('desktop: built dist/ and dist-renderer/ (with MediaPipe)')
