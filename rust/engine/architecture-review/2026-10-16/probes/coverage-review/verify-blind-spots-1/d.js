var R; try { var F = new Function('a', 'this.a = a'); var B = F.bind(null, 3).bind(null); R = [1].map(() => new B().a)[0]; } catch (e) { R = 'caught ' + e; } throw new Error(String(R));
