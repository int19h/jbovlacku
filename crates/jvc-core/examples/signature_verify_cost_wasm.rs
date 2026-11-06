#[path = "support/signature_verify_cost.rs"]
mod support;
use std::cell::RefCell;
use wasm_bindgen::prelude::*;

thread_local! {
    static EVENTS: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
}

#[wasm_bindgen]
pub fn load_events(bytes: &[u8]) -> std::result::Result<usize, JsValue> {
    let events: Vec<String> =
        serde_json::from_slice(bytes).map_err(|error| JsValue::from_str(&error.to_string()))?;
    let count = events.len();
    EVENTS.with(|target| *target.borrow_mut() = events);
    Ok(count)
}

#[wasm_bindgen]
pub fn verify_events(cached: bool) -> std::result::Result<String, JsValue> {
    EVENTS.with(|events| {
        support::verify(&events.borrow(), cached)
            .map_err(|error| JsValue::from_str(&error.to_string()))
    })
}
