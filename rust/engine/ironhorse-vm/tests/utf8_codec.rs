//! Ironhorse's native UTF-8 codec (`Uint8Array.decodeUtf8`, `encodeUtf8`,
//! `encodeUtf8Into`, `src/interp/natives/utf8.rs`) and the codec polyfill
//! built on it (`rust/endo/xsnap/src/polyfills.js`).
//!
//! Three layers: the natives on a bare machine; the polyfill's codec section
//! evaluated on a bare machine, as the Ironhorse boot prepends it; and the
//! committed Thixotrope boot (`packages/thixotrope/dist-ironhorse/boot.js`,
//! skipped when it has not been built), where the natives must be gone and
//! the classes must decode and encode a megabyte within one crank at the
//! default 10 M-computron budget.
mod common;
use common::TestCompiler;

use ironhorse_vm::{parse_symbols, Halt, Interp};

/// The default Thixotrope crank budget (`ironhorse-limits.js`).
const CRANK_BUDGET: u64 = 10_000_000;

/// A machine that runs one source text per crank, as the worker does.
struct Cranks {
    machine: Interp,
}

impl Cranks {
    fn new() -> Self {
        let mut machine = Interp::new();
        machine.set_source_compiler(std::rc::Rc::new(TestCompiler));
        Cranks { machine }
    }

    /// Run `source`, metered at `budget` when given; the result string, or
    /// the halt, and the computrons it used.
    fn run(&mut self, source: &str, budget: Option<u64>) -> (Result<String, Halt>, u64) {
        let machine = &mut self.machine;
        let (code, symbols) =
            ironhorse_compile::compile_atoms_goal(source, ironhorse_compile::Goal::Script, false)
                .expect("compiles");
        let names = parse_symbols(&symbols);
        let code = if machine.program_symbol_names().is_empty() {
            machine.link_intrinsics(&names);
            code
        } else {
            machine.relink_crank(&code, &names).expect("relinks")
        };
        if let Some(budget) = budget {
            machine.arm_meter(1000, Box::new(move |spent| spent <= budget));
        }
        let outcome = machine.run(&code);
        let computrons = outcome.computrons;
        if outcome.completed {
            (Ok(outcome.result), computrons)
        } else {
            (Err(outcome.halt), computrons)
        }
    }

    fn eval(&mut self, source: &str) -> String {
        match self.run(source, None).0 {
            Ok(result) => result,
            Err(halt) => panic!("{source:.80}: {halt:?}"),
        }
    }
}

fn on_big_stack<F: FnOnce() + Send + 'static>(f: F) {
    std::thread::Builder::new()
        .stack_size(ironhorse_vm::NATIVE_STACK_BYTES)
        .spawn(f)
        .unwrap()
        .join()
        .unwrap();
}

/// `decodeUtf8` of each hex input, as `text-units|consumed`, or `throws`.
const DECODE_PROBE: &str = r#"
var hex = h => Uint8Array.fromHex(h);
var units = s => Array.from(s, c => c.codePointAt(0).toString(16)).join(',');
var dec = (h, fatal) => {
  try {
    var r = Uint8Array.decodeUtf8(hex(h), fatal);
    return units(r.text) + '|' + r.consumed;
  } catch (e) { return e instanceof TypeError ? 'throws' : 'other:' + e; }
};
"#;

#[test]
fn decode_follows_the_whatwg_decoder_with_maximal_subpart_replacement() {
    on_big_stack(|| {
        let mut m = Cranks::new();
        m.eval(&format!("{DECODE_PROBE} 0"));
        for (input, lossy, fatal) in [
            // ASCII, two, three and four byte sequences.
            ("", "|0", "|0"),
            ("41", "41|1", "41|1"),
            ("c3a9", "e9|2", "e9|2"),
            ("e282ac", "20ac|3", "20ac|3"),
            ("f09f9880", "1f600|4", "1f600|4"),
            // A lone continuation byte, C0/C1 and F5..FF are each one error.
            ("80", "fffd|1", "throws"),
            ("c0af", "fffd,fffd|2", "throws"),
            ("c3", "|0", "|0"),
            ("ff41", "fffd,41|2", "throws"),
            // `c3 28`: the lead byte is one error and `(` is read again.
            ("c328", "fffd,28|2", "throws"),
            // Overlong encodings: E0 needs A0..BF next, F0 needs 90..BF.
            ("e080af", "fffd,fffd,fffd|3", "throws"),
            ("f08282ac", "fffd,fffd,fffd,fffd|4", "throws"),
            // Encoded surrogates: ED needs 80..9F next.
            ("eda080", "fffd,fffd,fffd|3", "throws"),
            ("edbfbf", "fffd,fffd,fffd|3", "throws"),
            // Past U+10FFFF: F4 needs 80..8F next.
            ("f4908080", "fffd,fffd,fffd,fffd|4", "throws"),
            // A truncated sequence followed by more input is one error per
            // maximal subpart.
            ("e28241", "fffd,41|3", "throws"),
            ("f09f9841", "fffd,41|4", "throws"),
            // A sequence cut short by the end of the input is left unconsumed.
            ("41e282", "41|1", "41|1"),
            ("41f09f98", "41|1", "41|1"),
            ("41f0", "41|1", "41|1"),
            // A byte order mark is not stripped here.
            ("efbbbf41", "feff,41|4", "feff,41|4"),
        ] {
            assert_eq!(
                m.eval(&format!("dec('{input}', false)")),
                lossy,
                "lossy {input}"
            );
            assert_eq!(
                m.eval(&format!("dec('{input}', true)")),
                fatal,
                "fatal {input}"
            );
        }
        // Not a Uint8Array.
        assert_eq!(
            m.eval(
                "var kinds = []; for (var x of [undefined, 'ab', [65], new Int8Array(1), \
                 new ArrayBuffer(1)]) { try { Uint8Array.decodeUtf8(x); kinds.push('ok'); } \
                 catch (e) { kinds.push(e instanceof TypeError); } } kinds.join()"
            ),
            "true,true,true,true,true"
        );
        // A view decodes only its own window, and the result's keys come in
        // the documented order.
        assert_eq!(
            m.eval(
                "var b = Uint8Array.fromHex('41e282ac42'); \
                 var r = Uint8Array.decodeUtf8(new Uint8Array(b.buffer, 1, 3), true); \
                 [r.text === '\\u20ac', r.consumed, Object.keys(r).join('/')].join(' ')"
            ),
            "true 3 text/consumed"
        );
    });
}

#[test]
fn encode_writes_utf8_and_replaces_unpaired_surrogates() {
    on_big_stack(|| {
        let mut m = Cranks::new();
        for (text, hex) in [
            ("''", ""),
            ("'A'", "41"),
            ("'\\u00e9'", "c3a9"),
            ("'\\u20ac'", "e282ac"),
            ("'\\ud83d\\ude00'", "f09f9880"),
            ("'\\ud83d'", "efbfbd"),
            ("'\\ude00'", "efbfbd"),
            ("'a\\ud83dz'", "61efbfbd7a"),
            ("'\\ude00\\ud83d'", "efbfbdefbfbd"),
            ("'\\u0000\\u07ff\\u0800\\uffff'", "00dfbfe0a080efbfbf"),
        ] {
            assert_eq!(
                m.eval(&format!(
                    "var e = Uint8Array.encodeUtf8({text}); \
                     [e.toHex(), e instanceof Uint8Array, e.length === e.buffer.byteLength].join(' ')"
                )),
                format!("{hex} true true"),
                "encodeUtf8 {text}"
            );
        }
        // `encodeUtf8Into` stops before a code point that does not fit whole.
        for (text, size, expected) in [
            ("'abc'", 8, "3 3 616263"),
            ("'abc'", 2, "2 2 6162"),
            ("'a\\u20ac'", 3, "1 1 61"),
            ("'a\\u20ac'", 4, "2 4 61e282ac"),
            ("'\\ud83d\\ude00'", 3, "0 0 "),
            ("'\\ud83d\\ude00'", 4, "2 4 f09f9880"),
            ("'\\ud83d'", 3, "1 3 efbfbd"),
        ] {
            assert_eq!(
                m.eval(&format!(
                    "var d = new Uint8Array({size}); var r = Uint8Array.encodeUtf8Into({text}, d); \
                     [r.read, r.written, d.subarray(0, r.written).toHex()].join(' ')"
                )),
                expected,
                "encodeUtf8Into {text} into {size}"
            );
        }
        assert_eq!(
            m.eval(
                "var r = Uint8Array.encodeUtf8Into('xyz', new Uint8Array(new ArrayBuffer(8), 2, 4)); \
                 Object.keys(r).join('/')"
            ),
            "read/written"
        );
        assert_eq!(
            m.eval(
                "var kinds = []; for (var a of [[1, new Uint8Array(1)], ['a', [0]], \
                 ['a', new Int8Array(1)]]) { try { Uint8Array.encodeUtf8Into(a[0], a[1]); \
                 kinds.push('ok'); } catch (e) { kinds.push(e instanceof TypeError); } } \
                 try { Uint8Array.encodeUtf8(1); } catch (e) { kinds.push(e instanceof TypeError); } \
                 kinds.join()"
            ),
            "true,true,true,true"
        );
        // A detached destination is refused.
        assert_eq!(
            m.eval(
                "var buf = new ArrayBuffer(4); var view = new Uint8Array(buf); buf.transfer(); \
                 var k; try { Uint8Array.encodeUtf8Into('a', view); k = 'ok'; } \
                 catch (e) { k = e instanceof TypeError; } k"
            ),
            "true"
        );
    });
}

#[test]
fn a_million_random_code_points_round_trip_natively() {
    on_big_stack(|| {
        let mut m = Cranks::new();
        // A deterministic xorshift over every scalar value: one in four
        // astral, the rest BMP outside the surrogates.
        let built = m.eval(
            "var seed = 0x2545f491; var next = () => { seed ^= seed << 13; seed ^= seed >>> 17; \
             seed ^= seed << 5; return seed >>> 0; }; \
             var parts = []; for (var i = 0; i < 1000000; i++) { var r = next(); \
             var cp = (r & 3) === 0 ? 0x10000 + (r >>> 2) % 0x100000 : (r >>> 2) % 0xf800; \
             if (cp >= 0xd800 && cp < 0xe000) cp += 0x800; parts.push(cp); } \
             var chunks = []; for (var j = 0; j < parts.length; j += 4096) \
               chunks.push(String.fromCodePoint.apply(null, parts.slice(j, j + 4096))); \
             globalThis.text = chunks.join(''); \
             [parts.length, text.length > 1000000].join()",
        );
        assert_eq!(built, "1000000,true");
        let (result, computrons) = m.run(
            "var bytes = Uint8Array.encodeUtf8(text); \
             var back = Uint8Array.decodeUtf8(bytes, true); \
             [back.text === text, back.consumed === bytes.length, bytes.length > 2000000].join()",
            Some(CRANK_BUDGET),
        );
        assert_eq!(result.as_deref(), Ok("true,true,true"));
        eprintln!("utf8 round trip of 1 M code points: {computrons} computrons");
        assert!(computrons < CRANK_BUDGET);
    });
}

/// The codec section the Ironhorse boot prepends (everything above the
/// `assert` marker, as `@endo/ironhorse-prelude/codec-polyfill.js` slices it).
fn codec_polyfill() -> String {
    let source = include_str!("../../../endo/xsnap/src/polyfills.js");
    let marker = source
        .find("// -- assert polyfill --")
        .expect("polyfills.js keeps its assert marker");
    source[..marker].to_string()
}

const POLYFILL_PROBE: &str = r#"
var hex = h => Uint8Array.fromHex(h);
var units = s => Array.from(s, c => c.codePointAt(0).toString(16)).join(',');
var attempt = f => { try { return f(); } catch (e) { return e.name + ': ' + e.message; } };
"#;

#[test]
fn the_polyfill_builds_whatwg_classes_on_the_natives_and_removes_them() {
    on_big_stack(|| {
        let mut m = Cranks::new();
        m.eval(&format!("{}\n{POLYFILL_PROBE} 0", codec_polyfill()));
        // The natives are captured and gone.
        assert_eq!(
            m.eval(
                "['decodeUtf8', 'encodeUtf8', 'encodeUtf8Into'].map(k => k in Uint8Array).join() + \
                 ' ' + typeof TextDecoder + ' ' + typeof TextEncoder"
            ),
            "false,false,false function function"
        );
        for (source, expected) in [
            // The euro sign split across three streaming calls, then flushed.
            (
                "var d = new TextDecoder(); [d.decode(hex('e2'), { stream: true }), \
                 d.decode(hex('82'), { stream: true }), d.decode(hex('ac'), { stream: true }), \
                 d.decode()].map(units).join('/')",
                "//20ac/",
            ),
            (
                "var d = new TextDecoder('utf-8', { fatal: true }); \
                 units(d.decode(hex('41e282'), { stream: true }) + d.decode(hex('ac42')))",
                "41,20ac,42",
            ),
            // `fatal` throws a TypeError on `c3 28`; otherwise U+FFFD.
            (
                "attempt(() => new TextDecoder('utf-8', { fatal: true }).decode(hex('c328')))",
                "TypeError: The encoded data was not valid for encoding utf-8",
            ),
            ("units(new TextDecoder().decode(hex('c328')))", "fffd,28"),
            // A truncated final sequence is one error when flushed.
            (
                "units(new TextDecoder().decode(hex('41f09f98')))",
                "41,fffd",
            ),
            (
                "attempt(() => new TextDecoder('utf-8', { fatal: true }).decode(hex('41f09f98')))",
                "TypeError: The encoded data was not valid for encoding utf-8",
            ),
            (
                "var d = new TextDecoder(); d.decode(hex('e282'), { stream: true }); \
                 units(d.decode())",
                "fffd",
            ),
            // A flushed decoder starts over: the carry does not leak.
            (
                "var d = new TextDecoder(); d.decode(hex('e282'), { stream: true }); d.decode(); \
                 units(d.decode(hex('41')))",
                "41",
            ),
            // Overlong and surrogate encodings are rejected.
            (
                "attempt(() => new TextDecoder('utf-8', { fatal: true }).decode(hex('c0af')))",
                "TypeError: The encoded data was not valid for encoding utf-8",
            ),
            (
                "attempt(() => new TextDecoder('utf-8', { fatal: true }).decode(hex('eda080')))",
                "TypeError: The encoded data was not valid for encoding utf-8",
            ),
            // A leading BOM is stripped once per stream unless `ignoreBOM`.
            ("units(new TextDecoder().decode(hex('efbbbf41')))", "41"),
            (
                "units(new TextDecoder().decode(hex('efbbbfefbbbf')))",
                "feff",
            ),
            (
                "units(new TextDecoder('utf-8', { ignoreBOM: true }).decode(hex('efbbbf41')))",
                "feff,41",
            ),
            (
                "var d = new TextDecoder(); [d.decode(hex('efbb'), { stream: true }), \
                 d.decode(hex('bf41'), { stream: true }), d.decode(hex('efbbbf'))]\
                 .map(units).join('/')",
                "/41/feff",
            ),
            (
                "var d = new TextDecoder(); d.decode(hex('41')); units(d.decode(hex('efbbbf42')))",
                "42",
            ),
            // Inputs: no argument, an ArrayBuffer, another view, a non-buffer.
            ("JSON.stringify(new TextDecoder().decode())", "\"\""),
            ("new TextDecoder().decode(hex('4142').buffer)", "AB"),
            (
                "new TextDecoder().decode(new DataView(hex('414243').buffer, 1, 1))",
                "B",
            ),
            (
                "attempt(() => new TextDecoder().decode('AB'))",
                "TypeError: TextDecoder.decode: input is not an ArrayBuffer or a view of one",
            ),
            (
                "var d = new TextDecoder('ascii', { fatal: true }); \
                 [d.encoding, d.fatal, d.ignoreBOM, d.decode(hex('41'))].join()",
                "utf-8,true,false,A",
            ),
            // The encoder.
            (
                "var e = new TextEncoder(); [e.encoding, e.encode('a\\u20ac').toHex(), \
                 e.encode('\\ud800').toHex(), e.encode().length].join()",
                "utf-8,61e282ac,efbfbd,0",
            ),
            (
                "var d = new Uint8Array(4); var r = new TextEncoder().encodeInto('a\\u20acb', d); \
                 [r.read, r.written, d.toHex()].join()",
                "2,4,61e282ac",
            ),
            (
                "attempt(() => new TextEncoder().encodeInto('a', []))",
                "TypeError: encodeInto destination must be a Uint8Array",
            ),
            // A hardened decoder still streams.
            (
                "var d = harden(new TextDecoder()); d.decode(hex('f09f'), { stream: true }); \
                 units(d.decode(hex('9880')))",
                "1f600",
            ),
        ] {
            assert_eq!(m.eval(source), expected, "{source}");
        }
    });
}

fn thixotrope_ses_boot() -> Option<String> {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../packages/thixotrope/dist-ironhorse/boot.js"
    );
    match std::fs::read_to_string(path) {
        Ok(source) => Some(source),
        Err(_) => {
            assert!(
                std::env::var_os("IRONHORSE_SES_SHIM_REQUIRED").is_none(),
                "IRONHORSE_SES_SHIM_REQUIRED is set but {path} is absent"
            );
            eprintln!(
                "utf8: dist-ironhorse/boot.js absent \u{2014} run \
                 `yarn workspace @endo/thixotrope build:ironhorse-bundles` to run this"
            );
            None
        }
    }
}

/// After the real SES boot the natives are gone, and the polyfill classes
/// decode and encode a megabyte within one crank at the default budget.
#[test]
fn after_the_ses_boot_a_megabyte_decodes_and_encodes_in_one_default_crank() {
    let Some(boot) = thixotrope_ses_boot() else {
        return;
    };
    if !boot.contains("decodeUtf8") {
        eprintln!("utf8: dist-ironhorse/boot.js predates the native codec; rebuild it");
        return;
    }
    on_big_stack(move || {
        let mut m = Cranks::new();
        m.eval(&format!(
            "var __e = undefined; try {{ {boot} }} catch (e) {{ __e = e; }} \
             __e ? 'ERROR: ' + __e.message : 'ok'"
        ));
        assert_eq!(
            m.eval(
                "['decodeUtf8', 'encodeUtf8', 'encodeUtf8Into'].map(k => k in Uint8Array).join() + \
                 ' ' + Object.isFrozen(TextDecoder.prototype)"
            ),
            "false,false,false true"
        );
        for (setup, op, expected) in [
            (
                "globalThis.input = Uint8Array.fromHex('61'.repeat(1048576)); 0",
                "new TextDecoder('utf-8', { fatal: true }).decode(input).length",
                "1048576",
            ),
            (
                "globalThis.input = Uint8Array.fromHex('61c3a9e282acf09f9880'.repeat(209715)); 0",
                "new TextDecoder('utf-8', { fatal: true }).decode(input).length",
                "1048575",
            ),
            (
                "globalThis.text = 'a'.repeat(1048576); 0",
                "new TextEncoder().encode(text).length",
                "1048576",
            ),
            (
                "globalThis.text = 'a\\u00e9\\u20ac\\ud83d\\ude00'.repeat(209715); 0",
                "new TextEncoder().encode(text).length",
                "2097150",
            ),
        ] {
            m.eval(setup);
            let (result, computrons) = m.run(op, Some(CRANK_BUDGET));
            eprintln!(
                "utf8 after boot: {op} [{setup:.40}] -> {result:?} in {computrons} computrons"
            );
            assert_eq!(result.as_deref(), Ok(expected), "{op} [{setup:.40}]");
        }
    });
}
