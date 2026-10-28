#!/bin/bash
# Generates visualizations of the internal package dependency graph.
# Also generates visualizations of the transitive reduction (tred) of
# that graph, which is the minimal graph with the same *transitive*
# dependencies. Much more legible by itelf. Seeing the two side by side
# often helps to understand the full picture.
set -ueo pipefail
DIR=$(dirname -- "${BASH_SOURCE[0]}")
# One "from to" line per dependency between local packages.
EDGES=$(cat "$DIR"/../packages/*/package.json | jq -r --slurp '
    . as $all |
    [.[] | {(.name): true}] | add as $locals |

    $all[] |
    .name as $from |
    (.dependencies // {}) |
    keys[] |
    {$from, to: .} |
    select($locals[.from] and $locals[.to]) |
    "\(.from) \(.to)"
')
{
    echo 'digraph {'
    # Left is depended upon the least and right the most.
    echo 'rankdir=LR'
    sed 's/^\(.*\) \(.*\)$/"\1" -> "\2"/' <<<"$EDGES"
    echo '}'
    # normalize
} | dot -Tcanon > packages-graph.dot
dot -Tpng <packages-graph.dot > "$DIR"/../packages-graph.png

dot -Tsvg <packages-graph.dot > "$DIR"/../packages-graph.svg

tred <packages-graph.dot > packages-graph-tred.dot
dot -Tpng <packages-graph-tred.dot > "$DIR"/../packages-graph-tred.png
dot -Tsvg <packages-graph-tred.dot > "$DIR"/../packages-graph-tred.svg

# Detect cycles with tsort rather than Graphviz's `acyclic`, which some
# distributions no longer package (Ubuntu 26.04's graphviz 14 omits it).
# tsort reports each loop it has to break as a header line followed by
# one line per package on the loop, so a loop of N packages yields N lines
# (one per cyclic edge) after the header is dropped.
if cycles=$(tsort <<<"$EDGES" 2>&1 >/dev/null); then
    echo "No cycles in 'dependencies' of packages."
else
    echo "Cycles detected. These packages lie on dependency loops:"
    grep -v -e 'input contains a loop' -e 'cycle in data' <<<"$cycles" |
        sed 's/^tsort: //'
fi
