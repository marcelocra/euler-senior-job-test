# FROM mcr.microsoft.com/devcontainers/typescript-node:24-bookworm
FROM mcr.microsoft.com/devcontainers/typescript-node:5.0.1-24

USER root
ENV TZ=America/Sao_Paulo LC_ALL=C.UTF-8 LANG=C.UTF-8
RUN apt-get update \
    && apt-get install -y --no-install-recommends tmux neovim \
    && apt-get clean -y \
    && rm -rf /var/lib/apt/lists/*

RUN chsh -s /usr/bin/zsh node
USER node
