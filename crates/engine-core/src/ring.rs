//! Shared-memory preview ring.
//!
//! The engine writes rendered preview frames here; the Electron preload addon reads
//! the newest one and copies it into a V8-owned buffer (the one copy the plan allows).
//!
//! Layout of the mapped file:
//! - 4 KiB header page: magic, version, slot size, slot count, `latest` (seq << 2 | slot)
//! - 3 slot headers inside that page (64 bytes each), each guarded by a seqlock
//! - then 3 frame slots of `slot_bytes` each (RGBA8, tightly packed rows)
//!
//! Seqlock per slot: the writer stores `seq * 2 + 1` while writing and `seq * 2 + 2`
//! when done. A reader accepts a frame only if the lock reads `seq * 2 + 2` both
//! before and after copying, so a torn frame is never shown.

use memmap2::{MmapMut, MmapOptions};
use std::fs::OpenOptions;
use std::io;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering, fence};
use std::time::{SystemTime, UNIX_EPOCH};

pub const MAGIC: u32 = 0x5354_5247; // "STRG"
pub const VERSION: u32 = 1;
pub const SLOTS: usize = 3;
pub const FORMAT_RGBA8: u32 = 0;

const HEADER_BYTES: usize = 4096;
const OFF_MAGIC: usize = 0;
const OFF_VERSION: usize = 4;
const OFF_SLOT_BYTES: usize = 8;
const OFF_SLOTS: usize = 16;
const OFF_LATEST: usize = 24;
const SLOT_HEADERS: usize = 64;
const SLOT_HEADER_BYTES: usize = 64;
const S_LOCK: usize = 0;
const S_WIDTH: usize = 8;
const S_HEIGHT: usize = 12;
const S_STRIDE: usize = 16;
const S_FORMAT: usize = 20;
const S_PTS: usize = 24;
const S_WRITTEN: usize = 32;

/// Total file size for a ring whose slots hold `slot_bytes` each.
pub fn ring_bytes(slot_bytes: usize) -> usize {
    HEADER_BYTES + SLOTS * slot_bytes
}

/// Wall-clock microseconds, comparable across processes (used for latency).
pub fn now_unix_us() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_micros() as u64).unwrap_or(0)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FrameMeta {
    pub seq: u64,
    pub width: u32,
    pub height: u32,
    pub stride: u32,
    pub format: u32,
    pub pts_us: u64,
    pub written_at_us: u64,
}

// The mapping is page aligned and every offset used with these helpers is a
// multiple of 8, so the pointers are valid and aligned for the whole mapping's life.
unsafe fn atomic<'a>(base: *mut u8, off: usize) -> &'a AtomicU64 {
    unsafe { AtomicU64::from_ptr(base.add(off) as *mut u64) }
}
unsafe fn put_u32(base: *mut u8, off: usize, v: u32) {
    unsafe { std::ptr::write_unaligned(base.add(off) as *mut u32, v.to_le()) }
}
unsafe fn put_u64(base: *mut u8, off: usize, v: u64) {
    unsafe { std::ptr::write_unaligned(base.add(off) as *mut u64, v.to_le()) }
}
unsafe fn get_u32(base: *const u8, off: usize) -> u32 {
    unsafe { u32::from_le(std::ptr::read_unaligned(base.add(off) as *const u32)) }
}
unsafe fn get_u64(base: *const u8, off: usize) -> u64 {
    unsafe { u64::from_le(std::ptr::read_unaligned(base.add(off) as *const u64)) }
}

fn map_file(path: &Path, len: Option<usize>) -> io::Result<MmapMut> {
    let file = OpenOptions::new().read(true).write(true).create(len.is_some()).truncate(false).open(path)?;
    if let Some(len) = len {
        // Reuse the same file across engine restarts so readers' mappings stay valid.
        if file.metadata()?.len() != len as u64 {
            file.set_len(len as u64)?;
        }
    }
    unsafe { MmapOptions::new().map_mut(&file) }
}

pub struct RingWriter {
    map: MmapMut,
    slot_bytes: usize,
    next_seq: u64,
}

impl RingWriter {
    /// Creates (or reuses) the ring file, sized for frames up to `max_width` × `max_height`.
    pub fn create(path: &Path, max_width: u32, max_height: u32) -> io::Result<Self> {
        let slot_bytes = max_width as usize * max_height as usize * 4;
        let mut map = map_file(path, Some(ring_bytes(slot_bytes)))?;
        let base = map.as_mut_ptr();
        unsafe {
            put_u32(base, OFF_MAGIC, MAGIC);
            put_u32(base, OFF_VERSION, VERSION);
            put_u64(base, OFF_SLOT_BYTES, slot_bytes as u64);
            put_u32(base, OFF_SLOTS, SLOTS as u32);
            atomic(base, OFF_LATEST).store(0, Ordering::Release);
        }
        Ok(Self { map, slot_bytes, next_seq: 1 })
    }

    pub fn slot_bytes(&self) -> usize {
        self.slot_bytes
    }

    /// Writes one frame. `fill` receives the slot's pixel buffer and the row stride in bytes.
    /// Returns the frame's sequence number.
    pub fn write_frame<F: FnOnce(&mut [u8], u32)>(&mut self, width: u32, height: u32, pts_us: u64, fill: F) -> u64 {
        let stride = width * 4;
        let len = stride as usize * height as usize;
        assert!(len <= self.slot_bytes, "frame {width}x{height} does not fit the ring's slots");
        let seq = self.next_seq;
        self.next_seq += 1;
        let slot = seq as usize % SLOTS;
        let base = self.map.as_mut_ptr();
        let sh = SLOT_HEADERS + slot * SLOT_HEADER_BYTES;
        unsafe {
            let lock = atomic(base, sh + S_LOCK);
            lock.store(seq * 2 + 1, Ordering::Relaxed);
            fence(Ordering::Release);
            put_u32(base, sh + S_WIDTH, width);
            put_u32(base, sh + S_HEIGHT, height);
            put_u32(base, sh + S_STRIDE, stride);
            put_u32(base, sh + S_FORMAT, FORMAT_RGBA8);
            put_u64(base, sh + S_PTS, pts_us);
            let pixels = std::slice::from_raw_parts_mut(base.add(HEADER_BYTES + slot * self.slot_bytes), len);
            fill(pixels, stride);
            put_u64(base, sh + S_WRITTEN, now_unix_us());
            lock.store(seq * 2 + 2, Ordering::Release);
            atomic(base, OFF_LATEST).store((seq << 2) | slot as u64, Ordering::Release);
        }
        seq
    }
}

pub struct RingReader {
    map: MmapMut,
    slot_bytes: usize,
}

impl RingReader {
    pub fn open(path: &Path) -> io::Result<Self> {
        let map = map_file(path, None)?;
        if map.len() < HEADER_BYTES {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "ring file too small"));
        }
        let base = map.as_ptr();
        let (magic, version, slot_bytes) = unsafe { (get_u32(base, OFF_MAGIC), get_u32(base, OFF_VERSION), get_u64(base, OFF_SLOT_BYTES) as usize) };
        if magic != MAGIC || version != VERSION || map.len() < ring_bytes(slot_bytes) {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "not a studio preview ring (or wrong version)"));
        }
        Ok(Self { map, slot_bytes })
    }

    pub fn slot_bytes(&self) -> usize {
        self.slot_bytes
    }

    /// Copies the newest complete frame into `dst` if it differs from `last_seq`.
    /// Returns `None` when there is no new frame, the frame is mid-write, or `dst` is too small.
    pub fn read_latest(&self, dst: &mut [u8], last_seq: u64) -> Option<FrameMeta> {
        let base = self.map.as_ptr() as *mut u8;
        unsafe {
            let latest = atomic(base, OFF_LATEST).load(Ordering::Acquire);
            if latest == 0 {
                return None;
            }
            let seq = latest >> 2;
            let slot = (latest & 3) as usize;
            if seq == last_seq || slot >= SLOTS {
                return None;
            }
            let sh = SLOT_HEADERS + slot * SLOT_HEADER_BYTES;
            let lock = atomic(base, sh + S_LOCK);
            let before = lock.load(Ordering::Acquire);
            if before != seq * 2 + 2 {
                return None;
            }
            let meta = FrameMeta {
                seq,
                width: get_u32(base, sh + S_WIDTH),
                height: get_u32(base, sh + S_HEIGHT),
                stride: get_u32(base, sh + S_STRIDE),
                format: get_u32(base, sh + S_FORMAT),
                pts_us: get_u64(base, sh + S_PTS),
                written_at_us: get_u64(base, sh + S_WRITTEN),
            };
            let len = meta.stride as usize * meta.height as usize;
            if len > dst.len() || len > self.slot_bytes {
                return None;
            }
            std::ptr::copy_nonoverlapping(base.add(HEADER_BYTES + slot * self.slot_bytes), dst.as_mut_ptr(), len);
            fence(Ordering::Acquire);
            if lock.load(Ordering::Relaxed) != before {
                return None;
            }
            Some(meta)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_ring(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("studio-ring-test-{}-{name}", std::process::id()))
    }

    #[test]
    fn writes_and_reads_back_the_newest_frame() {
        let path = temp_ring("roundtrip");
        let mut writer = RingWriter::create(&path, 8, 4).unwrap();
        let reader = RingReader::open(&path).unwrap();
        let mut dst = vec![0u8; reader.slot_bytes()];

        assert!(reader.read_latest(&mut dst, 0).is_none(), "empty ring has no frame");

        let seq = writer.write_frame(8, 4, 1_000, |px, _| px.fill(7));
        let meta = reader.read_latest(&mut dst, 0).expect("frame");
        assert_eq!((meta.seq, meta.width, meta.height, meta.stride, meta.pts_us), (seq, 8, 4, 32, 1_000));
        assert!(dst[..128].iter().all(|&b| b == 7));
        assert!(reader.read_latest(&mut dst, seq).is_none(), "same frame is not returned twice");

        for i in 0..4 {
            writer.write_frame(8, 4, 2_000 + i, |px, _| px.fill(i as u8));
        }
        let meta = reader.read_latest(&mut dst, seq).expect("newest frame");
        assert_eq!(meta.seq, seq + 4);
        assert!(dst[..128].iter().all(|&b| b == 3));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn reader_survives_writer_restart() {
        let path = temp_ring("restart");
        let mut first = RingWriter::create(&path, 4, 4).unwrap();
        let reader = RingReader::open(&path).unwrap();
        let mut dst = vec![0u8; reader.slot_bytes()];
        for _ in 0..10 {
            first.write_frame(4, 4, 0, |px, _| px.fill(1));
        }
        let old = reader.read_latest(&mut dst, 0).unwrap().seq;
        drop(first);
        let mut second = RingWriter::create(&path, 4, 4).unwrap();
        second.write_frame(4, 4, 0, |px, _| px.fill(9));
        let meta = reader.read_latest(&mut dst, old).expect("new session's frame");
        assert_eq!(meta.seq, 1);
        assert_eq!(dst[0], 9);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn rejects_files_that_are_not_rings() {
        let path = temp_ring("garbage");
        std::fs::write(&path, vec![0u8; 8192]).unwrap();
        assert!(RingReader::open(&path).is_err());
        let _ = std::fs::remove_file(path);
    }
}
