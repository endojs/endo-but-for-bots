throw new Error(JSON.stringify([typeof Atomics.wait, typeof Atomics.notify, typeof Atomics.waitAsync, Atomics.wait.length, Atomics.notify.length]));
