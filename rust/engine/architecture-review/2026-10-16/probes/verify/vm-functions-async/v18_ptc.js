"use strict"; function r(n){ if (n === 0) return "done"; return r(n-1); } var v; try { v = r(100000); } catch (e) { v = "caught " + e; } throw new Error(v);
