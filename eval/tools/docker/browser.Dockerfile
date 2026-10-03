# eval/tools browser image: the run's own image (which carries Chromium's OS libraries) +
# pinned Playwright with its Chromium, @axe-core/playwright and Lighthouse, installed as the
# non-root user `agent` like lib/playwright-mcp-install.sh does for the building agent.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
ARG PLAYWRIGHT_VERSION
ARG AXE_PLAYWRIGHT_VERSION
ARG AXE_CORE_VERSION
ARG LIGHTHOUSE_VERSION
USER agent
WORKDIR /home/agent/browser-tools
RUN npm init -y >/dev/null \
 && npm install --no-audit --no-fund --save-exact \
      "playwright@${PLAYWRIGHT_VERSION}" "@axe-core/playwright@${AXE_PLAYWRIGHT_VERSION}" \
      "axe-core@${AXE_CORE_VERSION}" "lighthouse@${LIGHTHOUSE_VERSION}" \
 && npx playwright install chromium \
 && node -e 'const {chromium}=require("playwright");console.log(chromium.executablePath())'
ENV NODE_PATH=/home/agent/browser-tools/node_modules
WORKDIR /workspace
