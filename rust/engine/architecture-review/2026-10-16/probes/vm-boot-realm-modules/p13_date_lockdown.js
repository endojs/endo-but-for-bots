var out = {};
function t(name, f) { try { out[name] = String(f()); } catch (e) { out[name] = e.name + ": " + e.message; } }
t("nowBefore", function () { return Date.now(); });
lockdown();
var c = new Compartment();
t("nowStart", function () { return Date.now(); });
t("nowInCompartment", function () { return c.evaluate("Date.now()"); });
t("newDateInCompartment", function () { return c.evaluate("new Date().getTime()"); });
t("dateIdentity", function () { return c.evaluate("Date") === Date; });
t("mathIdentity", function () { return c.evaluate("Math") === Math; });
t("protoCtor", function () { try { return (function(){}).constructor("return 1")(); } catch (e) { return e.name; } });
t("compartmentCtorInside", function () { return c.evaluate("Compartment") === Compartment; });
t("intlInCompartment", function () { return c.evaluate("typeof Intl"); });
t("localeDefault", function () { return new Intl.NumberFormat().resolvedOptions().locale; });
throw new Error(JSON.stringify(out));
