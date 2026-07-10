#![forbid(unsafe_code)]

mod domain;
mod error;

pub use domain::*;
pub use error::{IntegratorError, Result};

pub const DOMAIN_SCHEMA_VERSION: u32 = 2;
