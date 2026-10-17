var out = {};
function t(name, f){ try { out[name] = f(); } catch (e) { out[name] = 'THROW ' + (e && e.name) + ':' + String(e && e.message); } }
t('ab', function(){ var b = new ArrayBuffer(8); var k = 'byteLength'; return [String(b.byteLength), String(b[k]), String(Reflect.get(b, 'byteLength')), String('byteLength' in b), typeof Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get].join('|'); });
throw new Error(JSON.stringify(out));
