// README "Native recursion budget": past the ceiling "the crank halts with Halt::StackOverflow".
// Code (frames.rs:59) halts with Halt::ReentryLimit. 64 nested forEach callbacks.
function nest(n) { if (n === 0) return; [0].forEach(() => nest(n - 1)); }
nest(Number(64));
throw new Error("completed 64");
