# Kyutai moshi-server (Rust) — streaming TTS and STT over websockets, the server
# behind Unmute. Built from the published crate at image build time (the Unmute
# recipe compiles at first start; compiling here keeps the container immutable).
# The TTS module is Python-backed, so the image also carries the pinned uv venv
# from the moshi repo. Runs on the RTX 3060 only (compose pins the device).
FROM nvidia/cuda:12.8.1-devel-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl build-essential ca-certificates libssl-dev git pkg-config cmake wget \
        python3 python3-dev \
    && rm -rf /var/lib/apt/lists/*

RUN curl https://sh.rustup.rs -sSf | sh -s -- -y
ENV PATH="/root/.cargo/bin:$PATH"
COPY --from=ghcr.io/astral-sh/uv:0.7.2 /uv /uvx /bin/

WORKDIR /app
# The crate's Python side (torch, moshi) pinned by the moshi repo's lock at the commit Unmute uses.
ARG MOSHI_COMMIT=4fae088e130f6b44d489aefc0ef1836745e921de
RUN mkdir -p moshi-server && cd moshi-server \
    && wget -q https://raw.githubusercontent.com/kyutai-labs/moshi/${MOSHI_COMMIT}/rust/moshi-server/pyproject.toml \
    && wget -q https://raw.githubusercontent.com/kyutai-labs/moshi/${MOSHI_COMMIT}/rust/moshi-server/uv.lock \
    && uv sync --locked

# CUDA kernels for the 3060 (sm_86); the GPU is not visible at build time.
ENV CUDA_COMPUTE_CAP=86
ARG MOSHI_SERVER_VERSION=0.6.4
RUN cd moshi-server \
    && export LD_LIBRARY_PATH="$(uv run python -c 'import sysconfig; print(sysconfig.get_config_var("LIBDIR"))')" \
    && export CXXFLAGS="-include cstdint" \
    && cargo install --features cuda moshi-server@${MOSHI_SERVER_VERSION}

COPY configs /app/configs
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh && mkdir -p /app/static /tmp/moshi-logs

EXPOSE 8080
ENV RUST_BACKTRACE=1
HEALTHCHECK --start-period=5m --interval=30s CMD curl --fail http://localhost:8080/api/build_info || exit 1
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["worker", "--config", "/app/configs/vesta.toml", "--port", "8080"]
