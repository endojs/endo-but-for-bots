const a = []; for (let i = 0; i < 70000; i++) a.push(String(70000 - i));
let r; try { r = a.sort()[0]; } catch (e) { r = "caught " + e; } throw new Error("default sort dense 70000: " + r);
