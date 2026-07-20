#![forbid(unsafe_code)]

mod domain;
mod error;
mod projection;

pub use domain::*;
pub use error::{IntegratorError, Result};
pub use projection::*;

pub const DOMAIN_SCHEMA_VERSION: u32 = 9;
