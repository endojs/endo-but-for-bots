//! XS-differential regressions for the Iterator global's reflective surface
//! and the shared `%IteratorPrototype%` inherited by built-in iterators.

use ironhorse_262::{dual_run, Agreement};

fn agrees(source: &str) {
    let run = dual_run(source).expect("the XS oracle machine must start");
    assert_eq!(
        run.agreement,
        Agreement::BothComplete,
        "`{source}` must complete on both engines (ironhorse halt: {:?})",
        run.ironhorse_halt,
    );
    assert!(
        run.result_agrees,
        "`{source}` result divergence: oracle={:?} ironhorse={:?}",
        run.oracle_result, run.ironhorse_result,
    );
}

#[test]
fn iterator_constructor_and_helpers_have_specified_metadata() {
    for source in [
        "Iterator.name + ':' + Iterator.length",
        "Iterator.from.name + ':' + Iterator.from.length",
        "Iterator.prototype.map.name + ':' + Iterator.prototype.map.length",
        "Iterator.prototype.filter.name + ':' + Iterator.prototype.filter.length",
        "Iterator.prototype.take.name + ':' + Iterator.prototype.take.length",
        "Iterator.prototype.drop.name + ':' + Iterator.prototype.drop.length",
        "Iterator.prototype.flatMap.name + ':' + Iterator.prototype.flatMap.length",
        "Iterator.prototype.reduce.name + ':' + Iterator.prototype.reduce.length",
        "Iterator.prototype.toArray.name + ':' + Iterator.prototype.toArray.length",
        "Iterator.prototype.forEach.name + ':' + Iterator.prototype.forEach.length",
        "Iterator.prototype.some.name + ':' + Iterator.prototype.some.length",
        "Iterator.prototype.every.name + ':' + Iterator.prototype.every.length",
        "Iterator.prototype.find.name + ':' + Iterator.prototype.find.length",
    ] {
        agrees(source);
    }
}

#[test]
fn built_in_iterators_inherit_iterator_prototype() {
    agrees("[].values().map === Iterator.prototype.map");
    agrees("new Map().entries().map === Iterator.prototype.map");
    agrees("new Set().values().map === Iterator.prototype.map");
    agrees("var i = [1].values(); Iterator.from(i) === i");
    agrees("var i = new Map().entries(); Iterator.from(i) === i");
    agrees("var i = new Set().values(); Iterator.from(i) === i");
}

#[test]
fn iterator_constructor_is_abstract() {
    agrees("var ok = false; try { Iterator(); } catch (e) { ok = e instanceof TypeError; } ok");
    agrees("var ok = false; try { new Iterator(); } catch (e) { ok = e instanceof TypeError; } ok");
}

#[test]
fn to_array_consumes_intrinsic_iterators() {
    agrees("[1, 2, 3].values().toArray().join(',')");
    agrees("new Set([1, 2]).values().toArray().join(',')");
    agrees("new Map([[1, 'a'], [2, 'b']]).keys().toArray().join(',')");
    agrees("var i = [1, 2].values(); i.next(); i.toArray().join(',')");
    agrees("var ok = false; try { Iterator.prototype.toArray.call(1); } catch (e) { ok = e instanceof TypeError; } ok");
}
