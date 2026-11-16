// Zip files for Share project and Open shared project: written as they go (a project's media can
// be gigabytes), with Zip64 where a file or the archive passes 4 GB, and read back the same way.
// Files are stored as they are (video, sound and pictures are compressed already); small text
// files (.json, .jsonl, .txt, .log, .srt) are deflated. Readable by every unzip (checked with
// `unzip -t` in scripts/zip.test.mjs) and by Open shared project, which takes stored and
// deflated entries. No dependency: Node's zlib only.

import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import zlib from 'node:zlib'

const U32 = 0xffffffff
const U16 = 0xffff

/** CRC-32 of a file, read once. */
async function crcOf(file: string): Promise<number> {
  let crc = 0
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 1 << 20 })) crc = zlib.crc32(chunk as Buffer, crc)
  return crc >>> 0
}

/** A file's time as DOS date and time (what a zip keeps). */
function dosTime(d: Date) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2)
  const date = (Math.max(0, d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  return { time, date }
}

const DEFLATE = /\.(json|jsonl|txt|log|srt|cube)$/i

export interface ZipEntry {
  /** Its path in the zip, with forward slashes. */
  name: string
  /** A file on disk, or the bytes themselves. */
  file?: string
  data?: Buffer
}

/**
 * Writes `entries` to `out` (through `<out>.part`, renamed when it's whole). `progress` hears the
 * bytes written so far of `total`. Throws when `signal` is aborted.
 */
export async function writeZip(entries: ZipEntry[], out: string, progress?: (done: number, total: number) => void, signal?: AbortSignal) {
  const total = entries.reduce((n, e) => n + (e.data ? e.data.length : fs.statSync(e.file!).size), 0)
  const part = `${out}.part`
  const fd = fs.openSync(part, 'w')
  let at = 0
  let done = 0
  const write = (b: Buffer) => {
    fs.writeSync(fd, b, 0, b.length, at)
    at += b.length
  }
  const central: Buffer[] = []
  try {
    for (const e of entries) {
      if (signal?.aborted) throw new Error('Stopped.')
      const name = Buffer.from(e.name.replace(/\\/g, '/'), 'utf8')
      const stat = e.file ? fs.statSync(e.file) : null
      const { time, date } = dosTime(stat?.mtime ?? new Date())
      const size = e.data ? e.data.length : stat!.size
      const deflate = DEFLATE.test(e.name) && size < 64 * 1024 * 1024
      // Small text is deflated in memory; anything else is stored, its CRC read first.
      const raw = deflate ? (e.data ?? fs.readFileSync(e.file!)) : e.data
      const packed = deflate ? zlib.deflateRawSync(raw!) : null
      const crc = raw ? zlib.crc32(raw) >>> 0 : await crcOf(e.file!)
      const csize = packed ? packed.length : size
      const offset = at
      const big = size >= U32 || csize >= U32 || offset >= U32
      // Local header: Zip64 sizes in its extra field when a size passes 4 GB.
      const localExtra = size >= U32 || csize >= U32 ? Buffer.concat([u16(1), u16(16), u64(size), u64(csize)]) : Buffer.alloc(0)
      write(Buffer.concat([u32(0x04034b50), u16(big ? 45 : 20), u16(0x0800), u16(packed ? 8 : 0), u16(time), u16(date), u32(crc), u32(localExtra.length ? U32 : csize), u32(localExtra.length ? U32 : size), u16(name.length), u16(localExtra.length), name, localExtra]))
      if (packed) write(packed)
      else if (e.data) write(e.data)
      else {
        for await (const chunk of fs.createReadStream(e.file!, { highWaterMark: 1 << 20 })) {
          if (signal?.aborted) throw new Error('Stopped.')
          write(chunk as Buffer)
          done += (chunk as Buffer).length
          progress?.(done, total)
        }
        done -= size
      }
      done += size
      progress?.(done, total)
      // Central directory record: Zip64 sizes and offset where they pass 4 GB.
      const z64 = [...(size >= U32 ? [u64(size)] : []), ...(csize >= U32 ? [u64(csize)] : []), ...(offset >= U32 ? [u64(offset)] : [])]
      const extra = z64.length ? Buffer.concat([u16(1), u16(z64.length * 8), ...z64]) : Buffer.alloc(0)
      central.push(Buffer.concat([u32(0x02014b50), u16((3 << 8) | (big ? 45 : 20)), u16(big ? 45 : 20), u16(0x0800), u16(packed ? 8 : 0), u16(time), u16(date), u32(crc), u32(csize >= U32 ? U32 : csize), u32(size >= U32 ? U32 : size), u16(name.length), u16(extra.length), u16(0), u16(0), u16(0), u32((0o100644 << 16) >>> 0), u32(offset >= U32 ? U32 : offset), name, extra]))
    }
    const cdStart = at
    for (const c of central) write(c)
    const cdSize = at - cdStart
    const zip64 = entries.length >= U16 || cdStart >= U32 || cdSize >= U32
    if (zip64) {
      const end64 = at
      write(Buffer.concat([u32(0x06064b50), u64(44), u16(45), u16(45), u32(0), u32(0), u64(entries.length), u64(entries.length), u64(cdSize), u64(cdStart)]))
      write(Buffer.concat([u32(0x07064b50), u32(0), u64(end64), u32(1)]))
    }
    write(Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(zip64 ? U16 : entries.length), u16(zip64 ? U16 : entries.length), u32(zip64 ? U32 : cdSize), u32(zip64 ? U32 : cdStart), u16(0)]))
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(part, out)
  return { bytes: at }
}

/** An entry in a zip as read from its central directory. */
export interface ZipItem {
  name: string
  method: number
  csize: number
  size: number
  /** Where its local header starts. */
  offset: number
}

/** The entries of a zip (from its central directory; Zip64 understood). */
export function listZip(file: string): ZipItem[] {
  const fd = fs.openSync(file, 'r')
  try {
    const size = fs.fstatSync(fd).size
    const tail = Buffer.alloc(Math.min(size, 65_557))
    fs.readSync(fd, tail, 0, tail.length, size - tail.length)
    let e = -1
    for (let i = tail.length - 22; i >= 0; i--)
      if (tail.readUInt32LE(i) === 0x06054b50) {
        e = i
        break
      }
    if (e < 0) throw new Error('That isn’t a zip file (or it’s cut short).')
    let count = tail.readUInt16LE(e + 10)
    let cdSize = tail.readUInt32LE(e + 12)
    let cdStart = tail.readUInt32LE(e + 16)
    if (count === U16 || cdSize === U32 || cdStart === U32) {
      const loc = e - 20
      if (loc < 0 || tail.readUInt32LE(loc) !== 0x07064b50) throw new Error('That zip is missing its Zip64 record.')
      const end64 = Number(tail.readBigUInt64LE(loc + 8))
      const r = Buffer.alloc(56)
      fs.readSync(fd, r, 0, 56, end64)
      count = Number(r.readBigUInt64LE(32))
      cdSize = Number(r.readBigUInt64LE(40))
      cdStart = Number(r.readBigUInt64LE(48))
    }
    const cd = Buffer.alloc(cdSize)
    fs.readSync(fd, cd, 0, cdSize, cdStart)
    const out: ZipItem[] = []
    let p = 0
    for (let n = 0; n < count; n++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error('That zip’s list of files is damaged.')
      const method = cd.readUInt16LE(p + 10)
      let csize = cd.readUInt32LE(p + 20)
      let usize = cd.readUInt32LE(p + 24)
      const nameLen = cd.readUInt16LE(p + 28)
      const extraLen = cd.readUInt16LE(p + 30)
      const commentLen = cd.readUInt16LE(p + 32)
      let offset = cd.readUInt32LE(p + 42)
      const name = cd.subarray(p + 46, p + 46 + nameLen).toString('utf8')
      // Zip64 extra: the fields that were 0xFFFFFFFF, in order.
      let x = p + 46 + nameLen
      const xEnd = x + extraLen
      while (x + 4 <= xEnd) {
        const id = cd.readUInt16LE(x)
        const len = cd.readUInt16LE(x + 2)
        if (id === 1) {
          let q = x + 4
          if (usize === U32) (usize = Number(cd.readBigUInt64LE(q))), (q += 8)
          if (csize === U32) (csize = Number(cd.readBigUInt64LE(q))), (q += 8)
          if (offset === U32) offset = Number(cd.readBigUInt64LE(q))
        }
        x += 4 + len
      }
      out.push({ name, method, csize, size: usize, offset })
      p = xEnd + commentLen
    }
    return out
  } finally {
    fs.closeSync(fd)
  }
}

/** One entry written to `to` (its folders made), stored or deflated; its CRC isn't checked again. */
export async function extractItem(file: string, item: ZipItem, to: string) {
  if (item.method !== 0 && item.method !== 8) throw new Error(`${item.name} is packed in a way Studio doesn't read (method ${item.method}).`)
  const fd = fs.openSync(file, 'r')
  const head = Buffer.alloc(30)
  fs.readSync(fd, head, 0, 30, item.offset)
  fs.closeSync(fd)
  if (head.readUInt32LE(0) !== 0x04034b50) throw new Error(`${item.name} is damaged in the zip.`)
  const start = item.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28)
  fs.mkdirSync(path.dirname(to), { recursive: true })
  if (item.csize === 0) return fs.writeFileSync(to, Buffer.alloc(0))
  const src = fs.createReadStream(file, { start, end: start + item.csize - 1, highWaterMark: 1 << 20 })
  const tmp = `${to}.part`
  if (item.method === 8) await pipeline(src, zlib.createInflateRaw(), fs.createWriteStream(tmp))
  else await pipeline(src, fs.createWriteStream(tmp))
  fs.renameSync(tmp, to)
}

function u16(n: number) {
  const b = Buffer.alloc(2)
  b.writeUInt16LE(n & 0xffff)
  return b
}
function u32(n: number) {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n >>> 0)
  return b
}
function u64(n: number) {
  const b = Buffer.alloc(8)
  b.writeBigUInt64LE(BigInt(n))
  return b
}
