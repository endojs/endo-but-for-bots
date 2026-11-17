const r = [];
const T = (f) => { try { r.push(String(f())); } catch (e) { r.push(e.name + ':' + e.message); } };
const ins = ["1_000", "0x10", "0X1f", "0x", "0b101", "0o17", "0b", "-0x10", "+0x10", "Infinity", "-Infinity", "+Infinity", "infinity", "INFINITY",
 "﻿ 42 ﻿", " 42　", "᠎42", "\u0085 42", " \n\t 3.5e2 ", "1e", "1e+", ".5", "5.", ".", "+.5e1", "-.e1", "0.0000001", "1e400", "-1e-400",
 "", "   ", "12abc", "0x1g", "00012", "-0", "1.7976931348623159e308", "2.4703282292062328e-324", "2.4703282292062327e-324", "9007199254740993", "0.1e-1_0", "١٢", "0b2", "0o8", "0xFFFFFFFFFFFFFFFFFFFFFFFF", "1n", "  7"];
for (const s of ins) { T(() => Number(s)); T(() => parseFloat(s)); T(() => parseInt(s)); T(() => +s); }
T(() => parseInt("123", 37)); T(() => parseInt("zz", 36)); T(() => parseInt("0x1f", 16)); T(() => parseInt("1f", 0)); T(() => parseInt("  -0b1"));
T(() => parseInt("9007199254740993")); T(() => parseInt("1".repeat(400)));
T(() => parseFloat("Infinityx")); T(() => parseFloat("1e1000")); T(() => parseFloat("-.0"));
T(() => Number("0." + "0".repeat(400) + "1"));
T(() => Number("1" + "0".repeat(400) + "e-400"));
throw new Error(JSON.stringify(r));
