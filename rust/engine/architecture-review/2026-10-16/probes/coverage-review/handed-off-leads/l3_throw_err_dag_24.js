var a = ['xxxxxxxxxx']; for (var i = 0; i < 24; i++) a = [a, a]; var e = new Error('m'); e.message = a; throw e;
