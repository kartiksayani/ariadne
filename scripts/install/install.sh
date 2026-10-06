#!/bin/bash
# Installs the Ariadne alpha package this script ships in. It only runs install.py,
# which writes under $HOME/.local/share/ariadne and the owned links, nothing else.
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v python3 >/dev/null 2>&1 ||
   ! python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)'; then
  echo "Ariadne needs Python 3.11 or newer, and python3 on this Mac is missing or older." >&2
  echo "Install a current Python from https://www.python.org/downloads/macos/ (or run" >&2
  echo "'brew install python'), then run ./install.sh again." >&2
  exit 1
fi

exec python3 install.py install --package "$PWD"
