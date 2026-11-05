//! Row preparation and synchronous non-certified influence estimates.
//! Decisions remain non-certified. Host execution lives outside this module.
use crate::{Limits, RankError, Rational};
use num_traits::{One, ToPrimitive, Zero};
use std::collections::{BTreeMap, BTreeSet};

pub const ALGORITHM: &str = "simple-routes-shun-f64-v1";
pub const ROW_CONTRACT: &str = "jvc-f64-rows-v1";
pub const ROW_SUM_CEILING: f64 = f64::from_bits(0x3ff0_0000_0000_002d);

pub mod decisions;
mod propagation;
pub use propagation::{
    rank, Edge, Estimate, EstimateProgress, Failure, Graph, Parameters, Progress, Ranker, Ranking,
    Work,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PreparationError {
    NumericUnavailable,
    Graph(RankError),
}
impl std::fmt::Display for PreparationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NumericUnavailable => f.write_str("numeric_unavailable"),
            Self::Graph(error) => error.fmt(f),
        }
    }
}
impl std::error::Error for PreparationError {}

/// Convert a signed rational input, with zero allowed only when requested.
pub fn input(value: &Rational, allow_zero: bool) -> Result<f64, PreparationError> {
    let converted = value.to_f64().ok_or(PreparationError::NumericUnavailable)?;
    if !converted.is_finite()
        || converted.is_subnormal()
        || (converted == 0.0 && (!allow_zero || !value.is_zero()))
    {
        return Err(PreparationError::NumericUnavailable);
    }
    Ok(converted)
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Sum {
    total: f64,
    correction: f64,
}
impl Sum {
    pub fn new(value: f64) -> Result<Self, PreparationError> {
        if !value.is_finite() {
            return Err(PreparationError::NumericUnavailable);
        }
        Ok(Self {
            total: value,
            correction: 0.0,
        })
    }
    pub fn add(&mut self, value: f64) -> Result<(), PreparationError> {
        if !value.is_finite() {
            return Err(PreparationError::NumericUnavailable);
        }
        let next = self.total + value;
        let correction = self.correction
            + if self.total.abs() >= value.abs() {
                (self.total - next) + value
            } else {
                (value - next) + self.total
            };
        if !next.is_finite() || !correction.is_finite() || !(next + correction).is_finite() {
            return Err(PreparationError::NumericUnavailable);
        }
        self.total = next;
        self.correction = correction;
        Ok(())
    }
    pub fn finish(self) -> Result<f64, PreparationError> {
        let result = self.total + self.correction;
        result
            .is_finite()
            .then_some(result)
            .ok_or(PreparationError::NumericUnavailable)
    }
}

/// Accept only positive normal shares and a compensated total within the ceiling.
/// Accumulator corrections can be subnormal.
pub fn validate_row(shares: impl IntoIterator<Item = f64>) -> Result<(), PreparationError> {
    let mut sum = Sum::default();
    let mut count = 0;
    for share in shares {
        count += 1;
        if count > Limits::default().max_edges {
            return Err(PreparationError::Graph(RankError::ResourceLimit("edges")));
        }
        if !share.is_finite() || share.is_subnormal() {
            return Err(PreparationError::NumericUnavailable);
        }
        if share <= 0.0 {
            return Err(PreparationError::Graph(RankError::InvalidGraph(
                "row shares must be positive".into(),
            )));
        }
        sum.add(share)?;
    }
    if sum.finish()? > ROW_SUM_CEILING {
        return Err(PreparationError::Graph(RankError::InvalidGraph(
            "outgoing float shares exceed the row ceiling".into(),
        )));
    }
    Ok(())
}

/// Normalize retained rational weights before removing blocked destinations.
/// The caller resolves duplicates, private replacement, and self destinations.
pub fn normalize_row(
    weights: &BTreeMap<String, Rational>,
    blocked: &BTreeSet<String>,
) -> Result<BTreeMap<String, f64>, PreparationError> {
    let limits = Limits::default();
    if weights.len() > limits.max_edges {
        return Err(PreparationError::Graph(RankError::ResourceLimit("edges")));
    }
    for weight in weights.values() {
        if weight <= &Rational::zero() {
            return Err(PreparationError::Graph(RankError::InvalidGraph(
                "row weights must be positive".into(),
            )));
        }
        if weight.numer().bits().max(weight.denom().bits()) > limits.max_rational_bits {
            return Err(PreparationError::Graph(RankError::ResourceLimit(
                "fraction bits",
            )));
        }
    }
    let Some(maximum) = weights.values().max() else {
        return Ok(BTreeMap::new());
    };
    let mut ratios = BTreeMap::new();
    let mut sum = Sum::default();
    for (id, weight) in weights {
        let ratio = input(&(weight / maximum), false)?;
        sum.add(ratio)?;
        ratios.insert(id.clone(), ratio);
    }
    let sum = sum.finish()?;
    // Interpret the one binary64 total exactly. Never add the raw rationals.
    let no_scaling = maximum <= &Rational::one()
        && maximum * Rational::from_float(sum).ok_or(PreparationError::NumericUnavailable)?
            <= Rational::one();
    for (id, share) in &mut ratios {
        *share = if no_scaling {
            input(&weights[id], false)?
        } else {
            *share / sum
        };
        if !share.is_normal() || *share <= 0.0 {
            return Err(PreparationError::NumericUnavailable);
        }
    }
    validate_row(ratios.values().copied())?;
    ratios.retain(|id, _| !blocked.contains(id));
    validate_row(ratios.values().copied())?;
    Ok(ratios)
}
