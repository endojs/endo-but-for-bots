// Coverage-review probe (handed-off leads): what the XS oracle answers for the
// direct-eval context leads and for compartment-evaluator freezing.
#[test]
fn oracle_answers() {
    let cases = [
        ("eval super() in derived ctor",
         "var r; try { class B { constructor() { this.v = 1; } } class A extends B { constructor() { eval('super()'); } } r = String(new A().v); } catch (e) { r = 'threw ' + e.name; } r"),
        ("eval super() in arrow in derived ctor",
         "var r; try { class B { constructor() { this.v = 2; } } class A extends B { constructor() { (() => eval('super()'))(); } } r = String(new A().v); } catch (e) { r = 'threw ' + e.name; } r"),
        ("eval new.target in method",
         "var r; try { r = ({ m() { return eval('typeof new.target'); } }).m(); } catch (e) { r = 'threw ' + e.name; } r"),
        ("eval new.target in generator",
         "var r; try { r = (function* g() { yield eval('typeof new.target'); })().next().value; } catch (e) { r = 'threw ' + e.name; } r"),
        ("compartment evaluators frozen after lockdown",
         "lockdown(); var c = new Compartment({}); JSON.stringify([Object.isFrozen(c.evaluate('Function')), Object.isFrozen(c.evaluate('eval')), Object.isFrozen(c.evaluate('Compartment'))])"),
        ("compartment evaluators frozen, compartment before lockdown",
         "var c = new Compartment({}); lockdown(); JSON.stringify([Object.isFrozen(c.evaluate('Function')), Object.isFrozen(c.evaluate('eval')), Object.isFrozen(c.evaluate('Compartment'))])"),
        ("pre-flip closure called from child after lockdown",
         "globalThis.allowlist = ['alice']; var isAllowed = function (u) { return allowlist.includes(u); }; lockdown(); var c = new Compartment({ globals: { isAllowed: isAllowed } }); var r; try { r = String(c.evaluate(\"globalThis.allowlist = ['mallory']; isAllowed('mallory')\")); } catch (e) { r = 'threw ' + e.name + ': ' + e.message; } r"),
    ];
    for (label, src) in cases {
        match ironhorse_262::dual_run(src) {
            Some(r) => println!(
                "{label}: agreement={:?} oracle={:?} ironhorse={:?} oracle_error={:?} ih_error={:?}",
                r.agreement, r.oracle_result, r.ironhorse_result, r.oracle_error, r.ironhorse_error
            ),
            None => println!("{label}: oracle unavailable"),
        }
    }
}
