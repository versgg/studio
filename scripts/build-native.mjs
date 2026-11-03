// Builds the Rust engine and the preload addon, and puts the addon where Electron loads it.
import { execSync } from 'node:child_process'
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
execSync('cargo build --release -p studio-engine -p studio-bridge -p studio-mcp', { cwd: root, stdio: 'inherit' })

const lib = { win32: 'studio_bridge.dll', darwin: 'libstudio_bridge.dylib' }[process.platform] ?? 'libstudio_bridge.so'
const outDir = join(root, 'apps', 'desktop', 'native')
mkdirSync(outDir, { recursive: true })
copyFileSync(join(root, 'target', 'release', lib), join(outDir, 'studio_bridge.node'))
console.log(`native: copied ${lib} -> apps/desktop/native/studio_bridge.node`)
