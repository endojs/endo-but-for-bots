const line = "x".repeat(70000);
let r; try { r = (" " + line + " ").replace(/^\s+|\s+$/g, "").length; } catch (e) { r = "caught " + e; }
throw new Error("trim-replace:" + r);
