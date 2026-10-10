//! Calibration harness for the `Function.prototype.apply` array-like residual
//! (`APPLY_GENERIC_ARRAYLIKE_CREDIT` / `APPLY_ARGUMENTS_ARRAYLIKE_CREDIT` in
//! `ironhorse-vm/src/interp.rs`).
//!
//! Each row repeats one apply shape in a loop so the per-call residual is
//! visible above the fixed cost of the surrounding program, and prints the raw
//! 16.16 meter on both engines alongside the gap. The credits are the gap the
//! generic and arguments-object rows show once the full array schedule is
//! charged; the control rows at the bottom pin the loop's own cost.
//!
//! Run with `cargo run -p ironhorse-262 --example probe_apply_repeat`.

use ironhorse_262::dual_run;

fn main() {
    for source in [
        "var a={length:0},f=function(){return arguments.length},n=0;for(var i=0;i<10;i++)n+=f.apply(null,a);n",
        "var a={length:1,0:3},f=function(){return arguments.length},n=0;for(var i=0;i<10;i++)n+=f.apply(null,a);n",
        "var a={length:2,0:3,1:8},f=function(){return arguments.length},n=0;for(var i=0;i<10;i++)n+=f.apply(null,a);n",
        "var a={length:3,0:3,1:8,2:5},f=function(){return arguments.length},n=0;for(var i=0;i<10;i++)n+=f.apply(null,a);n",
        "(function(){var a=arguments,n=0;for(var i=0;i<10;i++)n+=Math.max.apply(null,a);return n})(3,8)",
        "var f=function(a){return a},a={get length(){return {valueOf:function(){return 1}}},0:7};f.apply(null,a)",
        "var f=function(a){return a},a={length:1n,0:7};try{f.apply(null,a);false}catch(e){e instanceof TypeError}",
        "var f=function(a,b){return a+b},apply=Function.prototype.apply.bind(f,null);apply({length:2,0:3,1:8})",
        "var f=function(){return 1},n=0;for(var i=0;i<10;i++)n+=f();n",
        "var a={length:0},f=function(){return 1},n=0;for(var i=0;i<10;i++)n+=f.apply(null,a);n",
        "var a={length:1,0:3},f=function(){return 1},n=0;for(var i=0;i<10;i++)n+=f.apply(null,a);n",
        "var a={length:2,0:3,1:8},f=function(){return 1},n=0;for(var i=0;i<10;i++)n+=f.apply(null,a);n",
        "(function(){var n=0;for(var i=0;i<10;i++)n+=Math.max(3,8);return n})()",
    ] {
        let run = dual_run(source).unwrap();
        println!("{}\n  result={:?}/{:?} oracle={} ih={} gap={} whole={}/{}", source, run.oracle_result, run.ironhorse_result, run.oracle_meter_raw, run.ironhorse_meter_raw, run.ironhorse_meter_raw as i64 - run.oracle_meter_raw as i64, run.oracle_computrons, run.ironhorse_computrons);
    }
}
