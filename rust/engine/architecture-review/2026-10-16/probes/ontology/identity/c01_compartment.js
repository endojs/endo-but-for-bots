var c = new Compartment();
throw new Error(JSON.stringify([typeof c.evaluate, c.evaluate("1+1")]));
