//! Lojban word-form tools shared by the browser and the native runtime: the
//! phonotactic tables, rafsi shapes, the lujvo builder, and the gismu
//! generator. Every function is pure. See docs/morphology.md for the profiles
//! and their versions, and THIRD-PARTY-NOTICES.md for the ported sources.
pub mod gismu;
pub mod lujvo;
pub mod phonotactics;
pub mod presets;
pub mod rafsi;
mod recognize;

pub use gismu::{GismuRequest, GismuResult, generate_gismu};
pub use lujvo::{
    Analysis, BuilderError, LujvoRequest, LujvoResult, Profile, analyze_word, build_lujvo,
};
pub use presets::{Preset, builder_presets};
