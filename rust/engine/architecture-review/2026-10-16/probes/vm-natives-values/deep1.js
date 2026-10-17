let r = [];
try { r.push(Array.isArray(JSON.parse('['.repeat(2000) + ']'.repeat(2000)))); } catch (e) { r.push(e.name); }
try { r.push(Array.isArray(JSON.parse('['.repeat(3000) + ']'.repeat(3000)))); } catch (e) { r.push(e.name); }
throw new Error(JSON.stringify(r));
