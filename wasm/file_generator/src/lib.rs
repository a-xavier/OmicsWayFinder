use js_sys::{Array, Function, Promise, Reflect, Uint8Array};
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;
use wasm_bindgen_futures::JsFuture;

const MAX_CHUNK_SIZE: usize = 8 * 1024 * 1024;

#[wasm_bindgen]
pub async fn run_file_generator(
    arguments: Array,
    writable: JsValue,
    progress: &Function,
) -> Result<(), JsValue> {
    if arguments.length() != 2 || arguments.get(0).as_string().as_deref() != Some("generate_file") {
        return Err(JsValue::from_str("Usage: generate_file <size_mib>"));
    }

    let size_mib = arguments
        .get(1)
        .as_string()
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or_else(|| JsValue::from_str("File size must be a non-negative integer in MiB."))?;
    let total_bytes = size_mib
        .checked_mul(1024 * 1024)
        .filter(|size| *size > 0)
        .ok_or_else(|| JsValue::from_str("File size must be greater than zero and within the supported range."))?;
    let write = Reflect::get(&writable, &JsValue::from_str("write"))?
        .dyn_into::<Function>()
        .map_err(|_| JsValue::from_str("Destination does not provide a write() method."))?;

    let mut written_bytes = 0_u64;
    let mut chunk_index = 0_u32;
    let mut last_reported_bytes = 0_u64;

    while written_bytes < total_bytes {
        let chunk_length = (total_bytes - written_bytes).min(MAX_CHUNK_SIZE as u64) as usize;
        let mut state = 0x9E37_79B9_u32 ^ chunk_index.wrapping_add(1);
        let mut bytes = vec![0; chunk_length];

        for byte in &mut bytes {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            *byte = (state >> 24) as u8;
        }

        let chunk = Uint8Array::from(bytes.as_slice());
        let result = write.call1(&writable, &chunk)?;
        JsFuture::from(Promise::resolve(&result)).await?;

        written_bytes += chunk_length as u64;
        chunk_index = chunk_index.wrapping_add(1);

        if written_bytes - last_reported_bytes >= 64 * 1024 * 1024
            || written_bytes == total_bytes
        {
            progress.call2(
                &JsValue::NULL,
                &JsValue::from_f64(written_bytes as f64),
                &JsValue::from_f64(total_bytes as f64),
            )?;
            last_reported_bytes = written_bytes;
        }
    }

    Ok(())
}