The Host needs a HOST special.
There's a bug in the interface definition of makeDirectory, which should accept a bare pet name as well as a pet name path array.

There may have been a regression in the remove command:
When I remove "ten", I get.
ENOENT: no such file or directory, lstat '/Users/kris/Library/Application Support/Endo/pet-store/f1/0767dfd734a796a3b8b6cf22b772928b53e74bae04dab373bd2b6c7657e66cc5993a4621069d72564d2c2bfb27b9751612ee6e91c32b62a343a8219888fb75/ten'

Big refactor needed to change identifier to locator.

Bit refactor needed to support listing and watching pet names with all 

makeFarContext -> makeExoContext, with help and interface

Ref-counting garbage collector for formulas.

Need a concept of reply chains for messages, and
for the chains to be weakly linked (so dismiss works)
but suitable for the AI agents to recreate transcripts.
The AI agent may need to be able to reconstruct transcripts
with edges that get dismissed, but still follow the shadow
link to prior nodes.
