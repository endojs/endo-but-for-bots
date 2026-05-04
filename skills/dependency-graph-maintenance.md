# Maintain the design dependency graph

## When to use

When grooming `designs/README.md` § "Dependency Graph", or when a
new design enters the corpus and its relationships need to be
threaded into the existing Mermaid graph.

## Inputs

- The current Mermaid block in `designs/README.md` § "Dependency
  Graph".
- Each design file's "Dependencies" section (if present), which
  lists prerequisite designs by relative path.
- The PR-mirror index at `changes/<N>.md` for cross-referencing
  whether prerequisite designs have already shipped.

## Procedure

1. **Enumerate edges from the design files.** For each design with
   a "Dependencies" section, parse the relative-path links and
   build an adjacency list `(this-design, prerequisite)`.
2. **Diff against the Mermaid graph.** Edges in the design files
   but missing from the graph need to be added. Edges in the graph
   but missing from any design file are suspect — either the design
   omitted documenting the dep, or the dep is wrong. Open a
   question for the user rather than guessing.
3. **Reconcile transitively-completed prerequisites.** A design
   whose only remaining prerequisite is `**Complete**` can move
   from "blocked" to "ready" in any project board the team uses;
   the graph itself doesn't change but the README narrative may.
4. **Detect cycles.** Run a topological sort over the adjacency
   list. A cycle is a real bug in either the design files or the
   graph; surface it as an open question.
5. **Update the Mermaid block.** Insert new nodes alphabetically
   within their milestone subsection. Insert edges as
   `prereq --> this`. Use `:::done` style hints for completed
   designs only if the existing graph already does.

## Output

A diff to the Mermaid block. Plus, for every divergence between
design files and the graph, an entry in the
[Open questions for the user](./groom-open-questions.md) note.

## Pitfalls

- The Mermaid graph is large (≈100 nodes in this project); a
  syntactically broken edit breaks rendering for the whole graph.
  Render locally before committing.
- Don't use redundant node IDs. Mermaid silently merges
  same-named nodes from different subgraphs. Prefix node IDs by
  milestone (e.g. `m2_ocapn_noise_network`).
- "Soft" dependencies (e.g., "this works better after X" but
  doesn't strictly require X) should not be edges. Keep the graph
  to hard prerequisites; flexibility lives in the milestone
  ordering, not in graph edges.
- A design that was reordered between milestones may need its
  edges re-classified. Check whether the target milestone of the
  prerequisite is still earlier than this design's milestone.
