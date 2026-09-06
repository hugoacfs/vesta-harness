#!/bin/bash
# The Rust binary embeds the venv's Python for the TTS module: expose that
# interpreter's shared library and site-packages, and call the Rust binary by
# full path (the moshi Python package installs a script of the same name).
set -e
cd /app/moshi-server
export LD_LIBRARY_PATH="$(uv run --locked --project /app/moshi-server python -c 'import sysconfig; print(sysconfig.get_config_var("LIBDIR"))')${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export PYTHONPATH="$(uv run --locked --project /app/moshi-server python -c 'import site; print(site.getsitepackages()[0])')${PYTHONPATH:+:$PYTHONPATH}"
cd /app
exec uv run --locked --project /app/moshi-server /root/.cargo/bin/moshi-server "$@"
