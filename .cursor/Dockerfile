# Cloud Agent base image for AI Integrator (Tauri + Rust + React/TypeScript).
#
# Stable system layer only: OS packages, Node.js, and the Rust toolchain live
# here. Repository-dependent work (npm install) runs in the environment.json
# `install` phase after checkout. The repository is intentionally NOT copied in;
# Cursor checks out the requested revision separately.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# Base tooling plus the WebKitGTK/GTK stack Tauri v2 requires to build and link
# the desktop shell on Linux.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        wget \
        file \
        git \
        pkg-config \
        build-essential \
        libssl-dev \
        libxdo-dev \
        libgtk-3-dev \
        libsoup-3.0-dev \
        librsvg2-dev \
        libayatana-appindicator3-dev \
        libwebkit2gtk-4.1-dev \
        sudo \
    && rm -rf /var/lib/apt/lists/*

# Ubuntu 24.04 ships a uid 1000 `ubuntu` user; grant passwordless sudo so the
# agent can install additional OS packages if a task requires them.
RUN usermod -aG sudo ubuntu \
    && echo "ubuntu ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/90-ubuntu \
    && chmod 0440 /etc/sudoers.d/90-ubuntu

# Node.js 22 (matches CI and the pinned npm@10.9.2 package manager).
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Rust toolchain, installed system-wide. `stable` satisfies the workspace
# rust-version (1.88) and edition 2024 requirements. rustfmt and clippy back the
# `format` and `lint` scripts.
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH
RUN curl -fsSL https://sh.rustup.rs | sh -s -- \
        -y --no-modify-path --profile minimal --default-toolchain stable \
    && rustup component add rustfmt clippy \
    && chmod -R a+rwX "$RUSTUP_HOME" "$CARGO_HOME"

USER ubuntu
