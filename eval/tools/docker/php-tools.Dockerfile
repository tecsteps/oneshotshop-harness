# eval/tools PHP image: the run's own image + PCOV (coverage for the agent's tests) + pinned
# Pint, PhpMetrics and cloc. Built by eval/tools/run.sh FROM the image id recorded in the run's
# meta.json, so tests run on exactly the run's PHP; tag = oneshotshop-tools-php:<image>-<hash>.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
ARG PCOV_VERSION
ARG PINT_VERSION
ARG PHPMETRICS_VERSION
ARG CLOC_VERSION
USER root
RUN install-php-extensions "pcov-${PCOV_VERSION}" \
 && printf 'pcov.enabled=1\npcov.directory=/workspace\n' > "$PHP_INI_DIR/conf.d/zz-pcov.ini" \
 && apt-get update && apt-get install -y --no-install-recommends "cloc=${CLOC_VERSION}" \
 && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /opt/tools/pint /opt/tools/phpmetrics \
 && COMPOSER_HOME=/tmp/composer composer --working-dir=/opt/tools/pint require --no-interaction --no-progress "laravel/pint:${PINT_VERSION}" \
 && COMPOSER_HOME=/tmp/composer composer --working-dir=/opt/tools/phpmetrics require --no-interaction --no-progress "phpmetrics/phpmetrics:${PHPMETRICS_VERSION}" \
 && rm -rf /tmp/composer
USER agent
