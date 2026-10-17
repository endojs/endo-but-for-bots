let r; try { const a = new Array(2**24).fill("abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz"); a.join(""); r = "completed"; } catch (e) { r = "caught " + e.name; }
throw new Error(r);
