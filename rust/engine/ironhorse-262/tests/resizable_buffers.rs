//! Resizable ArrayBuffers and growable SharedArrayBuffers agree with XS: the
//! `maxByteLength` option, `resize`, the `resizable`/`growable`/
//! `maxByteLength` accessors, length-tracking TypedArray and DataView views,
//! and the out-of-bounds answers of a view whose buffer shrank under it.
//! Where Ironhorse departs from XS on these (a SharedArrayBuffer's `grow`, the
//! order of `resize`'s receiver check), `xs_departures.rs` records it.

use ironhorse_262::{dual_run, Agreement};

fn assert_result_agrees(source: &str) {
    let dr = dual_run(source).expect("the XS oracle machine must start");
    assert_eq!(
        dr.agreement,
        Agreement::BothComplete,
        "`{source}` must complete on both engines (ironhorse halt: {:?}; oracle={:?} ironhorse={:?})",
        dr.ironhorse_halt,
        dr.oracle_result,
        dr.ironhorse_result,
    );
    assert!(
        dr.result_agrees,
        "`{source}` result divergence: oracle={:?} ironhorse={:?}",
        dr.oracle_result, dr.ironhorse_result,
    );
}

#[test]
fn max_byte_length_option_makes_a_resizable_buffer() {
    assert_result_agrees(
        "var a = new ArrayBuffer(8, { maxByteLength: 16 }), b = new ArrayBuffer(4, {}), \
         c = new ArrayBuffer(4, { maxByteLength: undefined }), d = new ArrayBuffer(4, 16); \
         [a.byteLength, a.maxByteLength, a.resizable, b.resizable, b.maxByteLength, \
          c.resizable, d.resizable].join()",
    );
}

#[test]
fn max_byte_length_is_read_and_converted_in_order() {
    assert_result_agrees(
        "var log = []; var len = { valueOf: function () { log.push('length'); return 2; } }; \
         var opts = { get maxByteLength() { log.push('get'); \
           return { valueOf: function () { log.push('max'); return 4; } }; } }; \
         var b = new ArrayBuffer(len, opts); log.push(b.maxByteLength); log.join()",
    );
    assert_result_agrees(
        "var r = []; \
         try { new ArrayBuffer(8, { maxByteLength: 4 }); } catch (e) { r.push(e.constructor.name); } \
         try { new ArrayBuffer(0, { maxByteLength: -1 }); } catch (e) { r.push(e.constructor.name); } \
         try { new SharedArrayBuffer(8, { maxByteLength: 4 }); } catch (e) { r.push(e.constructor.name); } \
         r.join()",
    );
}

#[test]
fn resize_grows_with_zeros_and_shrinks() {
    assert_result_agrees(
        "var b = new ArrayBuffer(4, { maxByteLength: 8 }); new Uint8Array(b).set([1, 2, 3, 4]); \
         b.resize(8); var grown = new Uint8Array(b).join(); b.resize(2); \
         var shrunk = new Uint8Array(b).join(); b.resize(0); \
         [grown, shrunk, b.byteLength, b.maxByteLength].join(':')",
    );
    assert_result_agrees(
        "var r = []; var b = new ArrayBuffer(4, { maxByteLength: 8 }); \
         try { b.resize(9); } catch (e) { r.push(e.constructor.name); } \
         try { b.resize(-1); } catch (e) { r.push(e.constructor.name); } \
         try { new ArrayBuffer(4).resize(4); } catch (e) { r.push(e.constructor.name); } \
         try { ArrayBuffer.prototype.resize.call(new SharedArrayBuffer(4, { maxByteLength: 8 }), 4); } \
         catch (e) { r.push(e.constructor.name); } \
         r.push(ArrayBuffer.prototype.resize.length, ArrayBuffer.prototype.resize.name); r.join()",
    );
}

#[test]
fn length_tracking_views_follow_the_buffer() {
    assert_result_agrees(
        "var b = new ArrayBuffer(8, { maxByteLength: 16 }); var t = new Uint16Array(b, 2); \
         var r = [t.length, t.byteLength, t.byteOffset]; b.resize(15); \
         r.push(t.length, t.byteLength); b.resize(2); r.push(t.length, t.byteOffset); \
         b.resize(1); r.push(t.length, t.byteLength, t.byteOffset); r.join()",
    );
    assert_result_agrees(
        "var b = new ArrayBuffer(4, { maxByteLength: 8 }); var t = new Uint8Array(b); \
         t[3] = 7; b.resize(8); t[7] = 9; var grown = t.join(); b.resize(2); \
         [grown, t.join(), t[3], 3 in t, Object.keys(t).join('')].join(':')",
    );
}

#[test]
fn a_fixed_length_view_goes_out_of_bounds_and_back() {
    assert_result_agrees(
        "var b = new ArrayBuffer(8, { maxByteLength: 16 }); var t = new Uint8Array(b, 4, 4); \
         t[0] = 5; b.resize(6); var r = [t.length, t.byteOffset, t.byteLength, t[0]]; \
         try { t.fill(1); } catch (e) { r.push(e.constructor.name); } \
         b.resize(8); r.push(t.length, t[0]); r.join()",
    );
}

#[test]
fn typed_array_methods_see_the_live_length() {
    assert_result_agrees(
        "var b = new ArrayBuffer(4, { maxByteLength: 8 }); var t = new Uint8Array(b); \
         t.set([4, 3, 2, 1]); b.resize(6); t.sort(); \
         [t.join(), t.slice(1).join(), t.subarray(2).length, t.indexOf(0), t.at(-1)].join(':')",
    );
    assert_result_agrees(
        "var b = new ArrayBuffer(4, { maxByteLength: 8 }); var t = new Uint8Array(b); \
         var s = t.subarray(1); b.resize(8); var tracked = s.length; \
         var fixed = t.subarray(1, 3); b.resize(2); [tracked, s.length, fixed.length].join()",
    );
}

#[test]
fn data_views_track_and_go_out_of_bounds() {
    assert_result_agrees(
        "var b = new ArrayBuffer(8, { maxByteLength: 16 }); var d = new DataView(b, 2); \
         var f = new DataView(b, 2, 4); var r = [d.byteLength, f.byteLength]; b.resize(12); \
         r.push(d.byteLength, f.byteLength); d.setUint8(9, 7); r.push(d.getUint8(9)); \
         b.resize(4); r.push(d.byteLength); \
         try { f.byteLength; } catch (e) { r.push(e.constructor.name); } \
         try { f.getUint8(0); } catch (e) { r.push(e.constructor.name); } \
         try { d.getUint16(1); } catch (e) { r.push(e.constructor.name); } r.join()",
    );
}

#[test]
fn growable_shared_buffers_have_their_prototype_accessors() {
    assert_result_agrees(
        "var g = new SharedArrayBuffer(8, { maxByteLength: 16 }), f = new SharedArrayBuffer(4); \
         [g.byteLength, g.maxByteLength, g.growable, f.growable, f.maxByteLength, \
          Object.getPrototypeOf(g) === SharedArrayBuffer.prototype, g instanceof SharedArrayBuffer, \
          SharedArrayBuffer.prototype.grow.length, SharedArrayBuffer.prototype.slice.length, \
          new Uint8Array(g).length, new Uint8Array(g.slice(2)).length].join()",
    );
    assert_result_agrees(
        "var r = []; \
         try { Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, 'growable').get.call(new ArrayBuffer(4)); } \
         catch (e) { r.push(e.constructor.name); } \
         try { new SharedArrayBuffer(4).grow(4); } catch (e) { r.push(e.constructor.name); } \
         try { new SharedArrayBuffer(4, { maxByteLength: 8 }).grow(2); } catch (e) { r.push(e.constructor.name); } \
         try { new SharedArrayBuffer(4, { maxByteLength: 8 }).grow(9); } catch (e) { r.push(e.constructor.name); } \
         r.join()",
    );
}

#[test]
fn views_on_a_resizable_buffer_refuse_prevent_extensions() {
    assert_result_agrees(
        "var b = new ArrayBuffer(4, { maxByteLength: 8 }); var r = []; \
         r.push(Reflect.preventExtensions(new Uint8Array(b)), \
                Reflect.preventExtensions(new Uint8Array(b, 0, 2)), \
                Reflect.preventExtensions(new Uint8Array(new ArrayBuffer(4))), \
                Reflect.preventExtensions(new Uint8Array(new SharedArrayBuffer(4, { maxByteLength: 8 }), 0, 2))); \
         try { Object.freeze(new Uint8Array(b, 0, 0)); } catch (e) { r.push(e.constructor.name); } \
         r.join()",
    );
}

#[test]
fn transfer_keeps_resizability_and_transfer_to_fixed_length_drops_it() {
    assert_result_agrees(
        "var b = new ArrayBuffer(4, { maxByteLength: 8 }); new Uint8Array(b)[1] = 2; \
         var c = b.transfer(6); var d = c.transferToFixedLength(); \
         [b.detached, b.resizable, c.resizable, c.maxByteLength, c.byteLength, \
          d.resizable, d.maxByteLength, new Uint8Array(d).join('')].join()",
    );
}

#[test]
fn slice_after_its_source_shrinks_to_nothing_copies_nothing() {
    // `start`'s coercion shrinks the buffer to zero, past the copy's first
    // byte: the result keeps its length and zeros (test262
    // `slice/resize-count-bytes-to-zero.js`, which once reached a slice of a
    // range past the new backing store).
    assert_result_agrees(
        "var b = new ArrayBuffer(16, { maxByteLength: 16 }); var t = new Uint32Array(b); \
         t.fill(1); var start = { valueOf: function () { b.resize(0); return 2; } }; \
         var r = t.slice(start); \
         b.resize(16); t.fill(1); t.constructor = Uint8Array; \
         var s = t.slice({ valueOf: function () { b.resize(0); return 3; } }); \
         [r.length, r.join(''), s.length, s.join('')].join()",
    );
}
