//! Shared core of the studio engine: the project model, the preview frame ring and the
//! wire protocol. Used by the engine binary and (ring only) the bridge addon.

mod layers;
pub mod look;
pub mod model;
pub mod protocol;
pub mod ring;
pub mod stems;
mod summary;
