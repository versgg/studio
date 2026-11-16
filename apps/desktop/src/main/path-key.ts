// One way to tell whether two paths are the same folder or file, for the main process: Windows
// and macOS (by default) don't tell upper and lower case apart in names, Linux does. The page's
// own is `sameFolder` in renderer/store.ts.
import path from 'node:path'

const folded = process.platform === 'win32' || process.platform === 'darwin'
export const pathKey = (p: string) => (folded ? path.resolve(p).toLowerCase() : path.resolve(p))
