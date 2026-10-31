var d = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "concat");
var names = Object.getOwnPropertyNames(ArrayBuffer.prototype).sort();
throw new Error("concat=" + (d ? typeof d.value : "absent") + " | own=" + names.join(","));
