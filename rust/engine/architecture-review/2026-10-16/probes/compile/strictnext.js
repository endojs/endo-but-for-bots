var srcs = ["'use strict'; 010", "'use strict'\n010", "'use strict'; 08", "function f(){ 'use strict'; 010 }", "'use strict'; var x = 010", "'use strict'; 0, 010", "function f(){ 'use strict'; \"\\01\" }", "'use strict'; '\\01'"];
var res = srcs.map(function (s) { try { (0, eval)(s); return "accepted"; } catch (e) { return e.name; } });
throw new Error(res.join(" | "));
