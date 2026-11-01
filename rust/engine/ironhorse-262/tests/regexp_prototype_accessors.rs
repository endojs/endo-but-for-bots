//! `%RegExp.prototype%`'s `source`, `flags` and eight flag getters are real
//! accessor properties, as XS's `fxBuildRegExp` installs them. Reads through
//! them, through a guest override of them, and through their extracted getter
//! functions are dual-run; the gate is result agreement where both engines
//! complete.

use ironhorse_262::{dual_run, Agreement};

const NAMES: [&str; 10] = [
    "dotAll",
    "flags",
    "global",
    "hasIndices",
    "ignoreCase",
    "multiline",
    "source",
    "sticky",
    "unicode",
    "unicodeSets",
];

fn agrees(source: &str) {
    let run = dual_run(source).expect("the pinned XS oracle machine must start");
    assert_eq!(run.agreement, Agreement::BothComplete, "{source}: {run:?}");
    assert!(run.result_agrees, "{source}: {run:?}");
}

fn caught(body: &str) -> String {
    format!("var r; try {{ r = String({body}); }} catch (e) {{ r = e.constructor.name; }} r")
}

#[test]
fn each_accessor_is_a_named_getter_without_a_setter() {
    for name in NAMES {
        agrees(&format!(
            "var d = Object.getOwnPropertyDescriptor(RegExp.prototype, '{name}'); \
             [typeof d.get, d.get.name, d.get.length, d.set, d.enumerable, d.configurable].join()"
        ));
    }
}

#[test]
fn getters_answer_for_instances_and_the_prototype() {
    for name in NAMES {
        let get = format!("Object.getOwnPropertyDescriptor(RegExp.prototype, '{name}').get");
        agrees(&caught(&format!("{get}.call(/a\\/b/dgimsy)")));
        agrees(&caught(&format!("{get}.call(new RegExp('', 'v'))")));
        agrees(&caught(&format!("{get}.call(RegExp.prototype)")));
    }
    agrees(
        "[RegExp.prototype.source, RegExp.prototype.flags, RegExp.prototype.toString()].join(' ')",
    );
}

#[test]
fn getters_reject_other_receivers_except_flags() {
    for name in NAMES {
        let get = format!("Object.getOwnPropertyDescriptor(RegExp.prototype, '{name}').get");
        for receiver in [
            "undefined",
            "1",
            "'a'",
            "Symbol()",
            "{}",
            "Object.create(/a/)",
        ] {
            agrees(&caught(&format!("{get}.call({receiver})")));
        }
    }
    // `flags` reads the receiver's eight flag properties, in order.
    agrees(
        "var log = []; var o = {}; \
         ['hasIndices','global','ignoreCase','multiline','dotAll','unicode','unicodeSets','sticky'] \
           .forEach(function (k, i) { Object.defineProperty(o, k, { get: function () { log.push(k); return i % 2; } }); }); \
         Object.getOwnPropertyDescriptor(RegExp.prototype, 'flags').get.call(o) + ' ' + log.join()",
    );
}

#[test]
fn a_guest_override_is_observed() {
    // An own property on the instance shadows the prototype getter.
    agrees(
        "var re = /a/g; Object.defineProperty(re, 'global', { value: 0 }); \
         [re.global, re.flags].join()",
    );
    // A replaced prototype getter is called, by the read and by `flags`.
    agrees(
        "Object.defineProperty(RegExp.prototype, 'sticky', { get: function () { return 'y?'; } }); \
         [/a/.sticky, /a/.flags, 'aaa'.replace(/a/, 'b')].join()",
    );
    // `source` and `flags` overrides reach `toString` and `new RegExp`.
    agrees(
        "Object.defineProperty(RegExp.prototype, 'source', { get: function () { return 'z'; } }); \
         var re = /a/i; [re.toString(), new RegExp(re).test('z')].join()",
    );
}
