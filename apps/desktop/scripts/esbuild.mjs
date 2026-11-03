// Bundles the Electron main process and the preload script (Node targets).
import { build } from 'esbuild'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

export async function buildMainAndPreload() {
  const common = {
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    // onnxruntime-node is a native addon with its own binaries: loaded from node_modules.
    external: ['electron', 'onnxruntime-node'],
    sourcemap: true,
    logLevel: 'warning',
  }
  await Promise.all([
    build({ ...common, entryPoints: [join(appRoot, 'src/main/main.ts')], outfile: join(appRoot, 'dist/main.js') }),
    build({ ...common, entryPoints: [join(appRoot, 'src/preload/preload.ts')], outfile: join(appRoot, 'dist/preload.js') }),
  ])
}
