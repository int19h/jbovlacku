use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn canonicalize(input: &[u8]) -> std::result::Result<Vec<u8>, JsValue> {
    crate::canonicalize_json(input).map_err(|e| JsValue::from_str(&e.to_string()))
}
#[wasm_bindgen]
pub fn verify_record(input: &[u8]) -> std::result::Result<Vec<u8>, JsValue> {
    crate::verify_envelope(input)
        .and_then(|e| e.canonical_envelope())
        .map_err(|e| JsValue::from_str(&e.to_string()))
}
#[wasm_bindgen]
pub fn check_body(envelope: &[u8], body: Option<Vec<u8>>) -> std::result::Result<String, JsValue> {
    let event = crate::verify_envelope(envelope).map_err(|e| JsValue::from_str(&e.to_string()))?;
    serde_json::to_string(&crate::inspect_body(&event, body.as_deref()))
        .map_err(|e| JsValue::from_str(&e.to_string()))
}
#[wasm_bindgen]
pub fn check_ed25519(public: &[u8], message: &[u8], signature: &[u8]) -> bool {
    let (Ok(public), Ok(signature)) = (public.try_into(), signature.try_into()) else {
        return false;
    };
    crate::verify_ed25519_profile(public, message, signature).is_ok()
}
#[wasm_bindgen]
pub fn word_identifier(input: &[u8]) -> std::result::Result<String, JsValue> {
    crate::parse_json(input)
        .and_then(|v| crate::word_id(&v))
        .map_err(|e| JsValue::from_str(&e.to_string()))
}
#[wasm_bindgen]
pub fn check_action(input: &[u8]) -> std::result::Result<bool, JsValue> {
    let event = crate::verify_envelope(input).map_err(|e| JsValue::from_str(&e.to_string()))?;
    Ok(crate::validate_action(event.header()).is_ok())
}
