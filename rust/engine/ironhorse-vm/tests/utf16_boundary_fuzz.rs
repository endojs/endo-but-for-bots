#[path = "support/utf16_probe.rs"]
mod utf16_probe;

#[test]
fn utf16_boundary_corpus_runs_without_an_oracle() {
    let cases = [
        vec![],
        vec![0xd800],
        vec![0xdc00],
        vec![0xd83d, 0xde00],
        vec![0xd800, 0xfffd, 0xdc00],
        vec![0, 0x27, 0x5c, 10, 13, 0x2028, 0x2029],
    ];
    for units in cases {
        let data: Vec<u8> = units.into_iter().flat_map(u16::to_le_bytes).collect();
        utf16_probe::probe(&data);
    }
    let mut state = 0x1234_5678u32;
    for _ in 0..64 {
        let data: Vec<u8> = (0..64)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                state as u8
            })
            .collect();
        utf16_probe::probe(&data);
    }
}
