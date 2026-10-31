var lit = 0x200000000000011;
var str = Number('0x200000000000011');
var pi = parseInt('200000000000011', 16);
throw new Error(JSON.stringify([String(lit), String(str), String(pi), lit === str, lit === pi]));
