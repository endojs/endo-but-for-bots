const r = [parseInt('48835871506362344'), parseInt('64503382158868181'), parseInt('1000000000000081', 16), Number('0x1000000000000081'),
  parseInt('12345678901234567891'), parseInt('123456789012345678901234567890'), Number('0b' + '1'.repeat(54) + '1'), parseInt('9007199254740993')];
throw new Error(JSON.stringify(r.map(String)));
