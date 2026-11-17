let c="no"; try { new RegExp("b{" + Number.MAX_SAFE_INTEGER + "}", "u"); c="compiled"} catch(e){c="caught "+e.name} throw new Error(c);
