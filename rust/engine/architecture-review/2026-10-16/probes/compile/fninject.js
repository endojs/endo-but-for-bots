// SES's makeFunctionConstructor validates guest text by calling the feral
// Function constructor on it before evaluating anything in the compartment.
var FERAL_FUNCTION = Function;
var startSecret = "start-compartment-only";
function validateLikeSES(parameters, bodyText) {
  try { new FERAL_FUNCTION(parameters, ""); } catch (e) { return "params:" + e.name; }
  try { new FERAL_FUNCTION(bodyText); } catch (e) { return "body:" + e.name; }
  return "validated";
}
var r1 = validateLikeSES("", "}); globalThis.leak1 = startSecret; (function(){");
var r2 = validateLikeSES("a) {}); globalThis.leak2 = startSecret; (function(b", "");
throw new Error([r1, r2, "leak1=" + globalThis.leak1, "leak2=" + globalThis.leak2].join(" | "));
