#!/bin/bash
# SLVR Auto-Staker — macOS launcher.
# Double-click this file to start the app. First run installs everything it needs.
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  Node.js is not installed yet."
  echo "  Please download the LTS version from https://nodejs.org and install it,"
  echo "  then double-click this file again."
  echo ""
  read -n 1 -s -r -p "  Press any key to close..."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "First run — installing dependencies (takes a minute)..."
  npm install --no-fund --no-audit || { read -n 1 -s -r -p "Install failed. Press any key to close..."; exit 1; }
fi

npm start
echo ""
read -n 1 -s -r -p "Press any key to close..."
