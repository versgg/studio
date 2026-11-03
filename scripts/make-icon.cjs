// Renders the app icon (apps/desktop/assets/icon.svg, the tile from the canvas) to
// icon.ico for Windows and icon.png for Linux. Runs inside Electron for its renderer:
//   npx electron scripts/make-icon.cjs
// At 32 px and below the coral dot grows (r 7.9 → 9), as on the canvas, so it stays visible.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const assets = path.join(__dirname, '..', 'apps', 'desktop', 'assets')
const svg = fs.readFileSync(path.join(assets, 'icon.svg'), 'utf8')
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } })
  await win.loadURL('data:text/html,<body></body>')
  const render = (size) => {
    const source = size <= 32 ? svg.replace('r="7.9"', 'r="9"') : svg
    return win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const img = new Image()
      img.onload = () => {
        const c = document.createElement('canvas')
        c.width = c.height = ${size}
        const g = c.getContext('2d')
        g.imageSmoothingQuality = 'high'
        g.drawImage(img, 0, 0, ${size}, ${size})
        resolve(c.toDataURL('image/png'))
      }
      img.onerror = reject
      img.src = 'data:image/svg+xml;base64,${Buffer.from(source).toString('base64')}'
    })`)
  }
  const png = async (size) => Buffer.from((await render(size)).split(',')[1], 'base64')

  // ICO with PNG entries (Windows Vista and later read these at every size).
  const images = []
  for (const s of ICO_SIZES) images.push(await png(s))
  const header = Buffer.alloc(6 + 16 * images.length)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)
  let offset = header.length
  images.forEach((data, i) => {
    const e = 6 + i * 16
    const s = ICO_SIZES[i]
    header.writeUInt8(s >= 256 ? 0 : s, e)
    header.writeUInt8(s >= 256 ? 0 : s, e + 1)
    header.writeUInt8(0, e + 2)
    header.writeUInt8(0, e + 3)
    header.writeUInt16LE(1, e + 4)
    header.writeUInt16LE(32, e + 6)
    header.writeUInt32LE(data.length, e + 8)
    header.writeUInt32LE(offset, e + 12)
    offset += data.length
  })
  fs.writeFileSync(path.join(assets, 'icon.ico'), Buffer.concat([header, ...images]))
  fs.writeFileSync(path.join(assets, 'icon.png'), await png(512))
  console.log(`icon: wrote icon.ico (${ICO_SIZES.join(', ')} px) and icon.png (512 px) in apps/desktop/assets`)
  app.quit()
})
