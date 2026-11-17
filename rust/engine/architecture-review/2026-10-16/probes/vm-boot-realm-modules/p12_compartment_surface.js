// Compartment / Hardened JavaScript surface as a guest sees it.
var out = {};
out.protoKeys = Reflect.ownKeys(Compartment.prototype).map(String);
var c = new Compartment({ globals: { a: 1 }, __options__: true });
function t(name, f) { try { out[name] = String(f()); } catch (e) { out[name] = e.name + ": " + e.message; } }
t("evaluate", function () { return c.evaluate("a + 1"); });
t("globalThisIsDistinct", function () { return c.globalThis !== globalThis; });
t("sharedObject", function () { return c.evaluate("Object") === Object; });
t("evalIdentity", function () { return c.evaluate("eval") === eval; });
t("import", function () { return typeof c.import; });
t("importNow", function () { return typeof c.importNow; });
t("name", function () { return new Compartment({ name: "n" }).name; });
t("ModuleSource", function () { return typeof ModuleSource; });
t("harden", function () { var o = harden({ x: {} }); return Object.isFrozen(o) && Object.isFrozen(o.x); });
t("petrify", function () { return typeof petrify; });
t("assert", function () { return typeof assert; });
t("HandledPromise", function () { return typeof HandledPromise; });
t("lockdownOptions", function () { return lockdown({ errorTaming: "unsafe" }); });
t("frozenAfter", function () { return Object.isFrozen(Array.prototype); });
t("lockdownAgain", function () { return lockdown(); });
t("compartmentAfter", function () { return new Compartment().evaluate("typeof lockdown + typeof harden + typeof Compartment"); });
t("mathRandom", function () { return typeof Math.random; });
t("dateNow", function () { return typeof Date.now(); });
t("newDate", function () { return typeof new Date().getTime(); });
throw new Error(JSON.stringify(out));
