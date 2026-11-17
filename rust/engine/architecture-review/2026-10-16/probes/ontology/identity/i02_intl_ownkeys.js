var names = Object.getOwnPropertyNames(Intl);
var d = Object.getOwnPropertyDescriptor(Intl, "__ironhorseDataVersion");
throw new Error(JSON.stringify([names.indexOf("__ironhorseDataVersion") >= 0, d && [d.writable, d.enumerable, d.configurable], typeof Intl.__ironhorseDataVersion]));
