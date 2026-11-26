//! The worker's budgets and arena ceilings, as the host configures them.

use ironhorse_vm::Interp;
use serde_json::Value;

/// JSON computron budgets are decimal strings so JS never rounds a u64.
pub fn positive_integer(value: &Value, name: &str) -> Result<u64, String> {
    let amount = match value {
        Value::String(text) if !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit()) => {
            text.parse::<u64>().ok()
        }
        Value::Number(number) => number.as_u64(),
        _ => None,
    };
    amount
        .filter(|n| *n > 0)
        .ok_or_else(|| format!("{name} must be a positive u64 integer"))
}

/// The limits the host passes as one JSON object: the default crank budget,
/// the budget of each boot source, and the arena ceilings. [`WorkerLimits::parse`]
/// is the only way to make one outside this crate, so every one is validated.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkerLimits {
    pub(crate) crank_budget: u64,
    pub(crate) bootstrap_budget: u64,
    pub(crate) slot_ceiling: u32,
    pub(crate) chunk_ceiling: u32,
}

impl WorkerLimits {
    /// The default budget of a request that names none, in computrons.
    pub fn crank_budget(&self) -> u64 {
        self.crank_budget
    }

    /// The budget of each boot source, in computrons.
    pub fn bootstrap_budget(&self) -> u64 {
        self.bootstrap_budget
    }

    pub fn slot_ceiling(&self) -> u32 {
        self.slot_ceiling
    }

    pub fn chunk_ceiling(&self) -> u32 {
        self.chunk_ceiling
    }

    pub fn parse(text: &str) -> Result<Self, String> {
        let value: Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
        Ok(Self {
            crank_budget: positive_integer(&value["crankBudget"], "crankBudget")?,
            bootstrap_budget: positive_integer(&value["bootstrapBudget"], "bootstrapBudget")?,
            slot_ceiling: u32::try_from(positive_integer(&value["slotCeiling"], "slotCeiling")?)
                .map_err(|_| "slotCeiling exceeds the u32 address space")?,
            chunk_ceiling: u32::try_from(positive_integer(&value["chunkCeiling"], "chunkCeiling")?)
                .map_err(|_| "chunkCeiling exceeds the u32 address space")?,
        })
    }

    /// Set the arena ceilings; under `consensus` the engine refuses one that
    /// some target cannot honor. Arena policy is not snapshot state, so a
    /// restored machine needs this again.
    pub fn apply(&self, machine: &mut Interp) -> Result<(), String> {
        machine
            .set_slot_ceiling(self.slot_ceiling)
            .map_err(|e| format!("slotCeiling refused: {e:?}"))?;
        machine
            .set_chunk_ceiling(self.chunk_ceiling as usize)
            .map_err(|e| format!("chunkCeiling refused: {e:?}"))?;
        Ok(())
    }
}
