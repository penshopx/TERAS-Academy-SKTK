#!/bin/bash
set -euo pipefail

# Compatibility entry point for focused ownership tests and existing operator
# commands. The canonical bootstrap also installs every other non-Drizzle
# function and trigger.
bash scripts/bootstrap-database-protections.sh