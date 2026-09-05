//! Mapped arguments must expose live formal values to generic Array methods
//! without leaking or rearranging the internal closure cells used as aliases.

use ironhorse_262::{dual_run, Agreement};

fn agrees(source: &str) {
    let run = dual_run(source).expect("the pinned XS oracle must start");
    assert_eq!(run.agreement, Agreement::BothComplete, "{run:?}");
    assert!(
        run.result_agrees,
        "`{source}` diverged: oracle={:?} ironhorse={:?}",
        run.oracle_result, run.ironhorse_result,
    );
}

#[test]
fn readonly_and_copying_methods_project_live_mapped_values() {
    for source in [
        "(function(a,b){b='z';return Array.prototype.join.call(arguments,':')})(1,2)",
        "(function(a,b){b='z';return Array.prototype.slice.call(arguments).join(':')})(1,2)",
        "(function(a,b){b='z';return Array.prototype.with.call(arguments,0,'x').join(':')+':'+a})(1,2)",
        "(function(a,b){b='z';return Array.prototype.toReversed.call(arguments).join(':')})(1,2)",
        "(function(a,b){b='z';return Array.prototype.indexOf.call(arguments,'z')})(1,2)",
        "(function(a,b){b='z';return Array.prototype.includes.call(arguments,'z')})(1,2)",
        "(function(a,b){b='z';return Array.prototype.at.call(arguments,1)})(1,2)",
        "(function(a,b){b='z';var out=[];Array.prototype.forEach.call(arguments,function(v){out.push(v)});return out.join(':')})(1,2)",
        "(function(a,b){b='z';return Array.prototype.map.call(arguments,function(v){return v}).join(':')})(1,2)",
    ] {
        agrees(source);
    }
}

#[test]
fn reverse_preserves_index_mapping_identity() {
    agrees(
        "(function(a,b){b='z';Array.prototype.reverse.call(arguments);return arguments[0]+':'+arguments[1]+':'+a+':'+b})(1,2)",
    );
}
