// Dev loop: Vite serves the renderer with hot reload; Electron loads it.
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import electron from 'electron'
import { createServer } from 'vite'
import { appRoot, buildMainAndPreload } from './esbuild.mjs'
import { copyMediapipe } from './mediapipe.mjs'

// MediaPipe's wasm and models, where Vite serves them as /mediapipe (its public folder).
copyMediapipe(join(appRoot, 'src', 'renderer', 'public', 'mediapipe'))
const server = await createServer({ configFile: join(appRoot, 'vite.config.mts') })
await server.listen()
const url = server.resolvedUrls.local[0]
await buildMainAndPreload()

const child = spawn(electron, ['.', ...process.argv.slice(2)], {
  cwd: appRoot,
  stdio: 'inherit',
  env: { ...process.env, VITE_DEV_SERVER_URL: url },
})
child.on('close', async (code) => {
  await server.close()
  process.exit(code ?? 0)
})
