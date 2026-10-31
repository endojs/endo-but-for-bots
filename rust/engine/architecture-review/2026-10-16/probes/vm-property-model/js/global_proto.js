var out = [];
out.push('proto:' + (Object.getPrototypeOf(globalThis) === null ? 'null' : 'object'));
out.push('typeof globalThis.hasOwnProperty:' + typeof globalThis.hasOwnProperty);
try { out.push('bare hasOwnProperty:' + hasOwnProperty('out')); } catch (e) { out.push('bare hasOwnProperty threw ' + e.name); }
try { out.push('String(globalThis):' + String(globalThis)); } catch (e) { out.push('String(globalThis) threw ' + e.name); }
out.push('instanceof Object:' + (globalThis instanceof Object));
throw new Error(out.join(' | '));
