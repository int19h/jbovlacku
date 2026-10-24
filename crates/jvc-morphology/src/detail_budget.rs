//! Bounds conflict scans and copied details across one complete result.
use crate::lujvo::BuilderError;

pub(crate) struct DetailBudget {
    work: u64,
    entries: u64,
    bytes: u64,
    limits: [u64; 3],
}
impl Default for DetailBudget {
    fn default() -> Self {
        Self::new(1_000_000, 20_000, 4_000_000)
    }
}
impl DetailBudget {
    pub(crate) fn new(work: u64, entries: u64, bytes: u64) -> Self {
        Self {
            work: 0,
            entries: 0,
            bytes: 0,
            limits: [work, entries, bytes],
        }
    }
    fn charge(value: &mut u64, amount: u64, limit: u64, measure: &str) -> Result<(), BuilderError> {
        *value = value.saturating_add(amount);
        if *value > limit {
            Err(BuilderError::ResourceLimit {
                measure: measure.into(),
                value: *value,
                limit,
            })
        } else {
            Ok(())
        }
    }
    pub(crate) fn scan(&mut self, amount: usize) -> Result<(), BuilderError> {
        Self::charge(
            &mut self.work,
            amount as u64,
            self.limits[0],
            "conflict detail work",
        )
    }
    pub(crate) fn detail(&mut self, fields: &[&str]) -> Result<(), BuilderError> {
        Self::charge(&mut self.entries, 1, self.limits[1], "conflict detail rows")?;
        let bytes = fields
            .iter()
            .fold(0u64, |n, s| n.saturating_add(s.len() as u64));
        Self::charge(
            &mut self.bytes,
            bytes,
            self.limits[2],
            "conflict detail bytes",
        )
    }
}
