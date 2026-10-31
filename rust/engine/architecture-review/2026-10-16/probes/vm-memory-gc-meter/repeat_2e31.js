try { "x".repeat(2**31) } catch (e) { throw new Error("caught " + e.name) }
