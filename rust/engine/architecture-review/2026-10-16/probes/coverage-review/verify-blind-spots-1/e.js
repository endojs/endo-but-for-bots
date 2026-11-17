var R; try { var F = new Function('a', 'this.a = a; return; ' + 'var z=1;'.repeat(50)); var B = F.bind(null, 3); R = new B().a; } catch (e) { R = 'caught ' + e; } throw new Error(String(R));
