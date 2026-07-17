#!/bin/sh

set -e 

echo "pnpm version: $(pnpm --version)"

are_engines_installed() {
    [ -f "$HOME/.engines/bin/xs" ] && [ -f "$HOME/.engines/bin/v8" ]
}


if ! are_engines_installed; then
    echo "xs and/or v8 not found in $HOME/.engines/bin; please run 'pnpm install-engines' to install them."
    exit 127
fi

pnpm rollup -c

pnpm eshost -h xs,v8 dist/bundle.js
