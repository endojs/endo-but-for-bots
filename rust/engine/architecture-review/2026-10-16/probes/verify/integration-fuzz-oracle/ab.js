function g(){ eval("{ function f4(){} }"); return typeof f4; } throw new Error(g());
