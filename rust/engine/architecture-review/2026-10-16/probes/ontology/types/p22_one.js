class G extends RegExp { get flags() { return "g"; } }
class NG extends RegExp { get flags() { return ""; } }
var r; try { r = JSON.stringify(RegExp.prototype.toString.call({source: 'x', flags: 'y'})); } catch (e) { r = "THROW " + e.name + ":" + e.message; }
throw new Error(r);
