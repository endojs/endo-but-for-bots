const d = new DataView(new ArrayBuffer(1024)); for (let i = 0; i < 2000000; i++) d.setUint8(i & 1023, i);
