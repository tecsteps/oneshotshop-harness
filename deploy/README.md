# deploy/ — hosting all shops on one server (placeholder)

This directory will hold the deployment of every finished run branch onto a single
Hetzner server (linux/amd64), e.g. via Laravel Forge, one site per run branch (`<YYYY-MM-DD>-<agent>-<model-slug>`) of the public `tecsteps/oneshotshop` repo.

Deployment credentials (for example `FORGE_TOKEN`) live only in the harness's git-ignored
`.env`. They are used on the host by deploy scripts and are never passed into run, gate or
evaluation containers.
