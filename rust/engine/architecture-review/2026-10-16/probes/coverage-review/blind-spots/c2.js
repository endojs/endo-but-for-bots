var out = [];
function t(name, f) { try { out.push([name, f()]); } catch (e) { out.push([name, 'THROW ' + (e && e.constructor && e.constructor.name) + ': ' + (e && e.message)]); } }
t('set-clear-iter', () => { var st = new Set([1,2,3]); var si = st.values(); si.next(); st.clear(); st.add(9); return [...si].join(','); });
t('map-clear-iter', () => { var m = new Map([[1,1],[2,2],[3,3]]); var mi = m.keys(); mi.next(); m.clear(); m.set(9,9); return [...mi].join(','); });
t('set-delete-readd', () => { var st = new Set([1,2,3]); var si = st.values(); si.next(); st.delete(1); st.add(1); return [...si].join(','); });
t('set-clear-before-next', () => { var st = new Set([1,2]); var si = st.values(); st.clear(); st.add(5); return [...si].join(','); });
t('set-foreach-clear', () => { var st = new Set([1,2,3]); var seen = []; st.forEach(function (v) { seen.push(v); if (v === 1) { st.clear(); st.add(7); } }); return seen.join(','); });
t('map-foreach-clear', () => { var m = new Map([[1,1],[2,2]]); var seen = []; m.forEach(function (v, k) { seen.push(k); if (k === 1) { m.clear(); m.set(8, 8); } }); return seen.join(','); });
t('set-exhausted-then-add', () => { var st = new Set([1]); var si = st.values(); si.next(); si.next(); st.add(2); return JSON.stringify(si.next()); });
throw new Error(JSON.stringify(out));
