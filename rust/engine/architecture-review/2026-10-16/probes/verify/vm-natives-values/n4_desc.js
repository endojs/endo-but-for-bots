const r = [];
const dd = Object.getOwnPropertyDescriptor(Intl.DateTimeFormat.prototype, 'format');
r.push(dd ? Object.keys(dd).join('|') + ':' + typeof dd.value + ':' + typeof dd.get : 'none');
const cd = Object.getOwnPropertyDescriptor(Intl.Collator.prototype, 'compare');
r.push(cd ? Object.keys(cd).join('|') + ':' + typeof cd.value + ':' + typeof cd.get : 'none');
const f = new Intl.DateTimeFormat('en'); r.push(typeof f.format, typeof Reflect.get(f, 'format'));
throw new Error(JSON.stringify(r));
