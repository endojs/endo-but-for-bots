// @ts-check

export const adoptionRepairMessage =
  '[system] The inbound message included attached references. Adopt each required attachment before responding. Use the exact adopt or adoptTool instruction shown above. Then continue the original request; if it asked you to use an attached tool, call that adopted tool before replying. Do not answer from memory.';

export const emptyResponseRepairMessage =
  '[system] Your previous response was empty. Continue from the tool results above and complete the request now. If the request is complete, call reply(...) now. Do not leave the response empty.';
