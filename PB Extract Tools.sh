#!/bin/sh
# Opens the pbx menu. Runs from this folder, whatever the current folder is. Needs chmod +x "PB Extract Tools.sh" once.
cd "$(dirname "$0")" && exec node pbx.mjs menu
