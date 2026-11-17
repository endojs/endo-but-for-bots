var last, caught='no', i; try { for (i = 0; i < 2000000; i++) { last = { a: i }; } } catch (e) { caught = 'yes'; } throw new Error(caught);
