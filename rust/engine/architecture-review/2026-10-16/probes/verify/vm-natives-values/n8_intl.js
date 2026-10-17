const r = [];
function t(f) { try { r.push(String(f())); } catch (e) { r.push(e.name + ':' + e.message); } }
t(() => new Intl.PluralRules('ru').select(3));
t(() => new Intl.PluralRules('ar').select(0));
t(() => new Intl.PluralRules('pl').select(5));
t(() => new Intl.PluralRules('ar').resolvedOptions().pluralCategories.join('|'));
t(() => new Intl.ListFormat('de').format(['a', 'b', 'c']));
t(() => new Intl.DateTimeFormat('de').format(0));
t(() => new Intl.DateTimeFormat('ja').format(0));
t(() => new Intl.NumberFormat('fr').format(1234567.891));
t(() => new Intl.Locale('th').maximize().toString());
t(() => new Intl.Locale('el').maximize().toString());
t(() => new Intl.NumberFormat('xx').resolvedOptions().locale);
t(() => Intl.getCanonicalLocales({ length: 1, 0: 'en' }).join());
t(() => new Date(0).toLocaleDateString('de-DE'));
t(() => new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: 'numeric', timeZone: 'UTC' }).format(Date.UTC(2020, 0, 1, 7, 0)));
t(() => Intl.PluralRules.supportedLocalesOf(['ru', 'ar', 'pl', 'de', 'ja']).join());
throw new Error(JSON.stringify(r));
