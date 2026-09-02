fn main() {
    let cases = [
        ("native apply 1-elem x16", "var n=0; var a=0; a=[]; n=a.push; for (var i=0;i<16;i++){ n.apply(a,[i]); } a.length"),
        ("user apply 1-elem x128",  "var f=0; f=function(x){return x;}; var s=0; for (var i=0;i<128;i++){ s=f.apply(null,[i]); } s"),
        ("user apply empty x64",    "var f=0; f=function(){return 1;}; var s=0; for (var i=0;i<64;i++){ s=f.apply(null,[]); } s"),
        ("user apply 3-elem x32",   "var f=0; f=function(a,b,c){return c;}; var s=0; for (var i=0;i<32;i++){ s=f.apply(null,[i,i,i]); } s"),
        ("native apply no-array",   "var n=0; var a=0; a=[1,2]; n=a.push; n.apply(a); a.length"),
        ("call control x64",        "var f=0; f=function(x){return x;}; var s=0; for (var i=0;i<64;i++){ s=f.call(null,i); } s"),
    ];
    let mut bad=0;
    for (name,src) in cases {
        match ironhorse_262::dual_run(src) {
            Some(dr) => { let d = dr.ironhorse_computrons as i64 - dr.oracle_computrons as i64;
                if d!=0 {bad+=1;}
                println!("{:26} oracle={:6} iron={:6} delta={:+}", name, dr.oracle_computrons, dr.ironhorse_computrons, d); }
            None => println!("{name:26} ORACLE FAILED"),
        }
    }
    println!("--- divergent: {bad}");
}
