let r; try { r = Array(2**32-1).join('').length; } catch (e) { r = "caught " + e.name + ": " + e.message; }
throw new Error(String(r));
