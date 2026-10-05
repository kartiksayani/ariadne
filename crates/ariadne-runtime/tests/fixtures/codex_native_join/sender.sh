#!/bin/sh
if [ "$#" = 1 ] && [ "$1" = --version ]; then
    printf 'codex-cli 0.160.0\n'
    exit 0
fi
fixture_dir=$(dirname "$0")
printf '%s\0' "$@" >> "$fixture_dir/argv"
printf 'sent\n' >> "$fixture_dir/sends"
if [ -f "$fixture_dir/lose-receipt" ]; then
    exit 7
fi
exit 0
