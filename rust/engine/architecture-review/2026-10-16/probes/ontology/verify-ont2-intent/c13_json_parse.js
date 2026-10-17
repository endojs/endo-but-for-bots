let r; try { r = JSON.parse('[' + Array.from({length:70000}, () => '0').join(',') + ']').length; } catch (e) { r = 'caught ' + e; } throw new Error(String(r));
