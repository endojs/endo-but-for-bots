//! The worker's NDJSON protocol, the same bytes from every shell.
//!
//! A shell writes [`ready_line`] once its heap is open (and, for a fresh
//! heap, booted and checkpointed), then hands each request line, without
//! its line terminator, to [`respond`] and does what the [`Step`] says.
//! Every line this module produces is one compact JSON object followed by
//! `\n`, ready to write as it stands.

use ironhorse_snapshot::machine::StoreSession;
use serde_json::{json, Value};

use crate::crank::{deliver, eval};
use crate::limits::{positive_integer, WorkerLimits};

/// The protocol features the ready line advertises. The host uses the
/// combined `deliver` request only when `deliver-v1` is among them.
pub const FEATURES: &[&str] = &["deliver-v1"];

/// What the shell does with one request line.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Step {
    /// Write the line and read the next request. The heap session stays open:
    /// this is a crank's result, or a malformed request's error.
    Continue(String),
    /// Write nothing; checkpoint the heap, close the store, exit successfully.
    Close,
    /// Write the `fatal` line, then exit failing with `error`, without
    /// checkpointing: nothing the failed crank did is committed.
    Die { line: String, error: String },
}

fn line(message: Value) -> String {
    format!("{message}\n")
}

/// The reply to a crank that did not complete.
pub(crate) fn fatal_line(message: &str) -> String {
    line(json!({"op":"fatal", "message":message}))
}

/// The record a shell writes when it is ready for requests.
pub fn ready_line() -> String {
    line(json!({"op":"ready", "features":FEATURES}))
}

/// A request names the source to evaluate and may override the crank budget.
/// A malformed request is the client's mistake, not a VM halt: it is answered
/// with an error reply and the heap session stays open for the next request.
pub fn parse_request(request: &Value, crank_budget: u64) -> Result<(&str, u64), String> {
    let source = request["source"].as_str().ok_or("source required")?;
    let budget = if request["budget"].is_null() {
        crank_budget
    } else {
        positive_integer(&request["budget"], "budget")?
    };
    Ok((source, budget))
}

/// Answer one request line. `op: "close"` closes; `op: "deliver"` is the
/// combined delivery; any other op, or none, is an eval. This is the bare
/// protocol over a session: [`crate::Worker::respond`] adds the store-fault
/// catch and the dead latch a shell relies on.
pub fn respond(session: &mut StoreSession, limits: &WorkerLimits, request: &str) -> Step {
    let request: Value = match serde_json::from_str(request) {
        Ok(request) => request,
        Err(error) => {
            return Step::Continue(line(json!({"op":"error", "message":error.to_string()})));
        }
    };
    if request["op"] == "close" {
        return Step::Close;
    }
    let (source, budget) = match parse_request(&request, limits.crank_budget) {
        Ok(parsed) => parsed,
        Err(error) => return Step::Continue(line(json!({"op":"error", "message":error}))),
    };
    let delivery = request["op"] == "deliver";
    let extraction_budget = if delivery && !request["drainBudget"].is_null() {
        match positive_integer(&request["drainBudget"], "drainBudget") {
            Ok(budget) => budget,
            Err(error) => return Step::Continue(line(json!({"op":"error", "message":error}))),
        }
    } else {
        limits.crank_budget
    };
    let outcome = if delivery {
        deliver(session, source, budget, extraction_budget)
    } else {
        eval(session, source, budget)
    };
    match outcome {
        // The heap is committed at close, not per crank. The host recovers
        // a worker from its last image plus its journal, never from this
        // file, so a checkpoint here bought no durability and cost a rewrite
        // of every side table the collection above marked dirty.
        Ok(result) => Step::Continue(line(json!({"op":"result", "result":result}))),
        Err(error) => Step::Die {
            line: fatal_line(&error),
            error,
        },
    }
}
