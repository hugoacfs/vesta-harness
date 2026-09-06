#!/bin/bash
# The Rust binary embeds a Python interpreter for the TTS module: point it at the
# pinned venv's libpython and run inside that venv.
set -e
cd /app/moshi-server
export LD_LIBRARY_PATH="$(uv run python -c 'import sysconfig; print(sysconfig.get_config_var("LIBDIR"))')${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
cd /app
exec uv run --locked --project /app/moshi-server moshi-server "$@"
