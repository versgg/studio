//! Preload-side native addon. Reads the newest preview frame from the engine's shared
//! ring and copies it into a buffer that V8 owns. Electron's memory cage forbids
//! handing JavaScript a pointer to outside memory, so this one copy is by design.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::path::Path;
use std::time::Instant;
use studio_engine_core::ring::RingReader;

#[napi(object)]
pub struct FrameInfo {
    pub seq: f64,
    pub width: u32,
    pub height: u32,
    pub stride: u32,
    pub pts_us: f64,
    pub written_at_us: f64,
    pub copy_us: f64,
}

#[napi]
pub struct PreviewRing {
    reader: RingReader,
}

#[napi]
impl PreviewRing {
    #[napi(constructor)]
    pub fn new(path: String) -> Result<Self> {
        RingReader::open(Path::new(&path))
            .map(|reader| Self { reader })
            .map_err(|e| Error::from_reason(format!("cannot open preview ring {path}: {e}")))
    }

    /// Bytes needed for one frame buffer.
    #[napi]
    pub fn slot_bytes(&self) -> u32 {
        self.reader.slot_bytes() as u32
    }

    /// Copies the newest frame into `target` if it is newer than `last_seq`.
    #[napi]
    pub fn read_latest(&self, mut target: Buffer, last_seq: f64) -> Option<FrameInfo> {
        let t0 = Instant::now();
        let meta = self.reader.read_latest(&mut target, last_seq as u64)?;
        Some(FrameInfo {
            seq: meta.seq as f64,
            width: meta.width,
            height: meta.height,
            stride: meta.stride,
            pts_us: meta.pts_us as f64,
            written_at_us: meta.written_at_us as f64,
            copy_us: t0.elapsed().as_secs_f64() * 1e6,
        })
    }
}
