let r; try { let s = "x"; for (let i = 0; i < 40; i++) s = s + s; r = "completed " + s.length; } catch (e) { r = "caught " + e.name; }
throw new Error(r);
