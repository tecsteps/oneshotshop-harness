# #OneShotShop run image: the starting point for every agent run and every gate check.
# No coding agent is baked in: the selected agent CLI is installed at run time by
# agents/<agent>/install.sh (latest version, recorded in meta.json). Neither is Playwright: lib/playwright-mcp-install.sh adds the pinned Playwright MCP + Chromium.
# Multi-arch: builds natively on linux/arm64 (Apple Silicon) and linux/amd64.
FROM node:22-bookworm-slim AS node

FROM php:8.4-cli-bookworm

ARG AGENT_UID=1000
ARG AGENT_GID=1000

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

# --- System tools --------------------------------------------------------
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git unzip zip jq ripgrep sqlite3 procps less openssh-client xz-utils \
      tmux nano file \
 && rm -rf /var/lib/apt/lists/*

# --- PHP extensions --------------------------------------------------------
# Already compiled into the official image: pdo_sqlite, sqlite3, mbstring, xml, dom,
# curl, fileinfo, tokenizer, ctype. Added here: intl, zip, bcmath, gd, opcache, pcntl.
ADD --chmod=0755 https://github.com/mlocati/docker-php-extension-installer/releases/latest/download/install-php-extensions /usr/local/bin/
RUN install-php-extensions intl zip bcmath gd opcache pcntl \
 && cp "$PHP_INI_DIR/php.ini-development" "$PHP_INI_DIR/php.ini" \
 && printf 'memory_limit=1G\n' > "$PHP_INI_DIR/conf.d/zz-oneshotshop.ini"

# --- Composer 2 --------------------------------------------------------------
COPY --from=composer:2 /usr/bin/composer /usr/local/bin/composer

# --- Node 22 LTS + npm ------------------------------------------------------
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && node -v && npm -v

# --- OS libraries for Chromium (root needed, so done here) ------------------------
# Only the shared libraries/fonts Chromium needs. Neither Playwright, Playwright MCP nor a
# browser is in the image: lib/playwright-mcp-install.sh installs the pinned MCP and its
# Chromium into the agent's HOME at run start (same script for building and evaluating).
ARG PLAYWRIGHT_DEPS_VERSION=1.63.0   # set from lib/versions.sh by docker/build.sh
RUN npx -y "playwright@${PLAYWRIGHT_DEPS_VERSION}" install-deps chromium \
 && rm -rf /root/.npm /var/lib/apt/lists/*

# --- Non-root agent user ------------------------------------------------------
RUN groupadd -g "${AGENT_GID}" agent \
 && useradd -m -u "${AGENT_UID}" -g agent -s /bin/bash -d /home/agent agent \
 && mkdir -p /workspace \
 && chown agent:agent /workspace \
 && git config --system safe.directory '*' \
 && git config --system init.defaultBranch main

USER agent
ENV HOME=/home/agent \
    PATH=/home/agent/.local/bin:/home/agent/.composer/vendor/bin:$PATH \
    NPM_CONFIG_PREFIX=/home/agent/.local \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    DISABLE_AUTOUPDATER=1 \
    COMPOSER_NO_INTERACTION=1

RUN mkdir -p /home/agent/.local/bin \
 && git config --global user.name "OneShotShop Agent" \
 && git config --global user.email "agent@oneshotshop.invalid"

WORKDIR /workspace
CMD ["bash"]
