var parts = []; for (var i = 0; i < 20000; i++) parts.push('{"k":' + i + '}'); var t = '[' + parts.join(',') + ']'; JSON.parse(t);
