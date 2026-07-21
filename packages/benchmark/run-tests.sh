#!/bin/sh

set -e 

echo "npm version: $(npm --version)"

are_engines_installed() {
    [ -f "$HOME/.engines/bin/xs" ] && [ -f "$HOME/.engines/bin/v8" ]
}


if ! are_engines_installed; then
    echo "xs and/or v8 not found in $HOME/.engines/bin; please run 'npm run install-engines' to install them."
    exit 127
fi

npm exec -- rollup -c

npm exec -- eshost -h xs,v8 dist/bundle.js
