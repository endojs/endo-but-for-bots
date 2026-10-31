let r;
try { new ArrayBuffer(300 * 1024 * 1024); r = 'ok'; } catch (e) { r = e.name; }
throw new Error(r);
