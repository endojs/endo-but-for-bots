let r; try { new ArrayBuffer(2**40); r = "completed"; } catch (e) { r = "caught " + e.name; }
throw new Error(r);
