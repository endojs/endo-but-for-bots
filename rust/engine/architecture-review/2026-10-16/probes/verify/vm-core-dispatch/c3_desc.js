var out = [];
function d(o, k) { var x = Object.getOwnPropertyDescriptor(o, k); return x ? (typeof x.get) : "absent"; }
out.push("dur.days=" + d(Temporal.Duration.prototype, "days"));
out.push("inst.epochMs=" + d(Temporal.Instant.prototype, "epochMilliseconds"));
out.push("pd.year=" + d(Temporal.PlainDate.prototype, "year"));
out.push("loc.language=" + d(Intl.Locale.prototype, "language"));
out.push("coll.compare=" + d(Intl.Collator.prototype, "compare"));
out.push("ds.disposed=" + (typeof DisposableStack === "function" ? d(DisposableStack.prototype, "disposed") : "noDS"));
var re = ["source","flags","global","ignoreCase","multiline","dotAll","unicode","unicodeSets","hasIndices","sticky","lastIndex"];
out.push("re:" + re.map(function(k){ return k + ":" + d(RegExp.prototype, k); }).join(","));
throw new Error(JSON.stringify(out));
