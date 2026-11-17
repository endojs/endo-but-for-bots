var srcs = ["'use strict'; (eval) => 1", "'use strict'; (arguments) => 1", "'use strict'; ([eval]) => 1", "'use strict'; ({a: arguments}) => 1", "'use strict'; (interface) => 1", "'use strict'; eval => 1", "'use strict'; ([a = 1, [arguments]]) => 1", "'use strict'; (a, eval) => 1", "'use strict'; (...eval) => 1", "'use strict'; async (eval) => 1"];
var res = srcs.map(function (s) { try { (0, eval)(s); return "accepted"; } catch (e) { return e.name; } });
throw new Error(res.join(" | "));
