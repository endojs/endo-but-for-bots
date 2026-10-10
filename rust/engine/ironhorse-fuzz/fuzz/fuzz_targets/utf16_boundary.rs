//! Design fuzz target 4: UTF-8/UTF-16 boundaries, including lone surrogates.
#![no_main]
use libfuzzer_sys::fuzz_target;

#[path = "../../../ironhorse-vm/tests/support/utf16_probe.rs"]
mod utf16_probe;

fuzz_target!(|data: &[u8]| {
    let data = data[..data.len().min(256)].to_vec();
    std::thread::Builder::new()
        .stack_size(ironhorse_vm::NATIVE_STACK_BYTES)
        .spawn(move || utf16_probe::probe(&data))
        .expect("spawn contract-stack thread")
        .join()
        .expect("UTF-16 values must survive compilation and conversion");
});
