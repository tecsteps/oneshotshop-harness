# #OneShotShop harness

Run harness for the **#OneShotShop v2** benchmark. Each AI coding agent gets the same spec
repository ([tecsteps/oneshotshop](https://github.com/tecsteps/oneshotshop), branch `main`) and
one prompt, then builds a complete Laravel B2B webshop on its own. Every run lives on its own
branch of that public repo, e.g. `2026-10-02-cursor-glm-5-3`.

The harness keeps agents in an isolated Docker container that cannot touch the host, and makes
every run identical and measured. It is a separate repository so the building agent never sees
harness files, evaluation material or prompt machinery: the agent only gets a fresh clone of the
spec repo's `main` history and the one prompt.

## Tutorial: one benchmark run, start to finish

All commands run in the harness directory (`cd ~/Herd/oneshotshop-harness`). `<branch>` is the
run's branch name that step 2 prints, e.g. `2026-10-02-codex-sol-6-1`.

### 0. One-time setup

1. **Docker Desktop** → Settings → Resources: memory **≥ 8 GB**. Every run gets the standard
   limits of 8 CPUs and **7g**; other values print "results not comparable".
2. **Build the run image** (repeat whenever `docker/` changes; old runs keep their recorded image id):
   ```bash
   docker/build.sh            # -> oneshotshop-runner:<date> + oneshotshop-runner:current
   ```
3. **Host `claude` CLI logged in**: the paid evaluation steps run `claude -p --model sonnet` on
   your Mac with your own login. Check with `claude -p "say ok"`. Also needed on the host:
   `node` (≥ 18), `jq`, `git`, `tmux` (`brew install tmux`).
4. **Harness `.env`** (git-ignored; template `.env.example`): nothing needed for runs.
   `FORGE_TOKEN` is for the later deploy step and never enters a container.

### 1. Before a run: check the challenge input

The input is `main` of `tecsteps/oneshotshop`: **one** commit. The prompt is that repo's
README `## Prompt` section, the single source of truth. If you changed the spec or the prompt,
it must be folded into that single commit and pushed first (ask Claude to do it). Check that
local and GitHub agree:

```bash
git -C ../oneshotshop status --short                 # must print nothing
git -C ../oneshotshop rev-list --count main          # 1
git -C ../oneshotshop rev-parse main                 # these two hashes
git -C ../oneshotshop ls-remote origin main          # must be identical
```

### 2. Start the run (inside tmux)

```bash
tmux new -s oss                         # host tmux: the run survives a closed terminal
./oneshotshop codex "Sol 6.1"           # agents: claude codex cursor opencode
# second run of the same model on the same day:  ./oneshotshop codex "Sol 6.1" --suffix 2
```

It clones `main` (branch `<YYYY-MM-DD>-<agent>-<model-slug>`), starts the container, installs the
latest agent CLI plus the Playwright MCP (about 30–60 s) and prints `… ready; Playwright MCP 0.0.83
(Chromium …) available: true`. Then the banner shows the agent and version, the
**login** command, **`check-mcp`**, the **start** command and the prompt in a box. You land in
a shell in `/workspace` of the container.

### 3. In the container

1. **Log in** with the command from the banner (claude: `claude`, then `/login`; codex:
   `codex login --device-auth`; cursor: `NO_OPEN_BROWSER=1 cursor-agent login`; opencode:
   `opencode auth login`). Open the printed URL on your Mac.
2. **`check-mcp`**: one tiny call on your login. It must print **PASS** (the agent lists
   `browser_navigate` and reads the title "Example Domain"). Don't continue on FAIL.
3. **Start a FRESH agent session** with the start command from the banner, e.g.
   `codex --dangerously-bypass-approvals-and-sandbox -m <model> -c model_reasoning_effort=high`.
   Choose model and reasoning effort deliberately and **use the same settings for every run you
   want to compare**. Experiments (screenshots, questions) are only allowed before, in a separate
   session, which you quit first.
4. **Paste the prompt as the first message**: copy it from the banner box, or print it with
   `cat ~/PROMPT.md` and copy that. Paste exactly that text, nothing else.
5. **Leave it alone.** Detach with `Ctrl-b d` (the agent keeps working); come back with
   `tmux attach -t oss`.

### 4. The agent says it is done

Quit the agent, then type `exit` in the container shell and answer the question
`Finish run <branch> now? [Y/n]`:

- **Y** (or Enter): copies the agent's transcripts out (credential files excluded), checks that the
  prompt was the first message, commits leftovers (never `vendor/`, `node_modules/`, `.env*`),
  records wall time and limits in `runs/<branch>/meta.json` and removes the container.
- **n**: everything stays as it is; continue later with `./oneshotshop resume <branch>`.

### 5. Look at the shop

```bash
./oneshotshop serve <branch>
```

After a few minutes of `composer install`, `npm ci`, build and seeding it prints
`http://127.0.0.1:8000/` (or the next free port) plus the admin login and three customer logins
from the spec, and where the admin sign-in is if the shop's README says so. Click through, take
screenshots and save them as `runs/<branch>/human/screenshots/NN-short-title.png`
(e.g. `01-home.png`; captions optional in `captions.md`: `01-home.png: Home page`).
**Ctrl-C** stops it and deletes the container.

### 6. Evaluate

```bash
./oneshotshop evaluate <branch>            # runs in the background, this window follows the log
./oneshotshop evaluate <branch> --detach   # or: start and return immediately
./oneshotshop status <branch>              # RUNNING/not running, per-step status, costs, perf headline
```

Ctrl-C or a closed window only stops following; the evaluation goes on (log:
`runs/<branch>/evaluate.log`). Steps and rough figures from the first real run:

| Step | What | Time | Cost |
|---|---|---|---|
| gate | README start command on a fresh clone, `GET /` = 200 | ~0.5–2 min | free |
| tools | static analysis + security/a11y scans | ~8 min | free |
| testplan | acceptance test, host `claude -p --model sonnet` + Playwright, 14 suites | ~1 h (8 suites took 31 min) | ~$20 (8 suites cost $11.36) |
| perf | queries, N+1, round trips | ~4 min | free |
| insights | stats + transcript analysis, host `claude -p --model sonnet` | a few min | a few $ (capped at $10) |
| human | creates your impression template | instant | — |
| report | `runs/<branch>/report.json` | instant | free |

If the gate fails, testplan and perf are skipped. **Interrupted or failed?** Run the same
`./oneshotshop evaluate <branch>` again: finished steps are skipped and the testplan resumes at
the first suite without a result.

### 7. Your impression

Edit `runs/<branch>/human/impression.md` (created by evaluate; overall impression, what
impressed/annoyed you, UX, would you use it, optional 1–10 score), add screenshots/captions,
then rebuild the report:

```bash
./oneshotshop evaluate <branch> --steps human,report
```

**Logins for exploring the shop** (from `specs/admin.md` and `specs/customers.md`; with
`./oneshotshop serve <branch>` the shop runs at http://127.0.0.1:8000). The admin sign-in
address is whatever the build documents in its README (v2 Codex: `/admin/login`).

| Account | Email | Password | Good for checking |
|---|---|---|---|
| Administrator (back office) | admin@spreegrund.example | Spreegrund!Admin2026 | products, packaging, orders, customers, promotions |
| Osthafen Küche (Gastronomy) | einkauf@osthafen-kueche.example | Hafen#2026 | negotiated prices, saved order list "Weekly bar order" |
| Osthafen Küche, 2nd user | kueche@osthafen-kueche.example | Kombuese!26 | shared company data |
| Café Morgenrot (Gastronomy) | hallo@cafe-morgenrot.example | Morgen!2026 | first order, WELCOME10 |
| Hotel Seeblick (Key Account) | purchasing@hotel-seeblick.example | Seeblick#Key8 | exclusive wine WINE-008, two delivery addresses |
| Feinkost Lindner (Retail, Munich) | bestellung@feinkost-lindner.example | Lindner!80331 | no spirits, credit limit almost used up |
| Wiener Genuss (Austria) | office@wiener-genuss.example | Wien!1060 | reverse charge, EU parcel only |
| De Kaasboer (Netherlands, no VAT ID) | inkoop@dekaasboer.example | Kaas!Amsterdam1 | German VAT despite EU address |
| Spätkauf am Kanal (Standard, Berlin) | kontakt@spaetkauf-kanal.example | Kanal!10999 | plain customer without discounts |
| Kantine Nordlicht (pending approval) | einkauf@kantine-nordlicht.example | Nordlicht!13353 | sees no prices until approved |
| Imbiss Ecke (blocked) | info@imbiss-ecke.example | Imbiss!2026 | must not be able to sign in |

If the spec's accounts change, `specs/customers.md` and `specs/admin.md` are authoritative.

### 8. Publish the run branch

```bash
./oneshotshop push <branch>       # pushes <branch> to tecsteps/oneshotshop with your git credentials
```

The repository is public: check the branch for real secrets (e.g. a committed `.env`) first.

### 9. Later (not yet automated)

- Deploy all shops to the Hetzner server via Laravel Forge (`deploy/`, uses `FORGE_TOKEN`).
- Update the website (agentic-engineers.dev) from `runs/<branch>/report.json`.

### If something goes wrong

| Situation | What to do |
|---|---|
| Mac terminal closed during the run | Nothing is lost while tmux runs: `tmux attach -t oss` |
| Run shell gone (tmux killed, reboot) | The container is still there: `./oneshotshop resume <branch>`. An agent started in the old shell has stopped; start it again only if that is acceptable for the benchmark |
| Exited the shell and answered `n` | `./oneshotshop resume <branch>`, or `./oneshotshop finish <branch>` to wrap up without a shell |
| Evaluate stopped (window closed, error) | `./oneshotshop status <branch>` shows why; `./oneshotshop evaluate <branch>` resumes |
| `check-mcp` prints FAIL | Follow its "Likely fix" (agent's `mcp list`, logged in?). Don't paste the prompt until it passes |
| Warning "limits differ from the standard run" or "exceeds the Docker VM" | Stop (`exit`, answer Y, then delete `runs/<branch>`), raise Docker Desktop memory to ≥ 8 GB, start again without `--cpus`/`--memory` |
| `could not clone branch 'main'` | The spec repo has no pushed `main`: push it (step 1) |

**Editing the harness while a run or an evaluation is in progress is safe.** Every long-running
script (`oneshotshop`, `lib/evaluate.sh`, `lib/serve.sh`, `verify.sh`, `eval/{tools,testplan,perf}/run.sh`)
keeps its whole body in a `main()` function that bash parses completely before running it, so a
file changed on disk can no longer corrupt a running process (this once crashed a `finish` with
"syntax error near unexpected token"). Changes take effect for the next command you start.

## The prompt

The prompt is **always the `## Prompt` section of the spec repo's `README.md`**, as cloned into
the run (from the line after the heading up to the next `## ` heading, trimmed). It is versioned
with the spec; there is no second prompt in the harness. At run start the harness extracts it
(and refuses to start if the section is missing), stores it as `runs/<branch>/prompt.md` and in
`meta.json` (`prompt.text`, `prompt.sha256`, `prompt.source: "README.md#Prompt @ <spec commit>"`),
writes it to `~/PROMPT.md` in the container HOME (not `/workspace`) and shows it in the banner in
a copyable box. Paste exactly that text as the first message of a fresh agent session.

## The run flow

```
./oneshotshop <agent> "<model label>" [--suffix x] [--spec url|path]
  1. clone main of the spec repo  -> runs/<branch>/workspace   (only committed files)
     create branch <YYYY-MM-DD>-<agent>-<model-slug>[-suffix], remove the origin remote
  2. start a container from the run image (only the workspace is mounted, CPU/memory limits)
  3. install the selected agent CLI (latest)                agents/<agent>/install.sh
     install Playwright MCP (pinned) + its Chromium          lib/playwright-mcp-install.sh
     register the MCP server for that agent at user level    agents/<agent>/mcp.sh
     check it with the agent's own `mcp list`
     install check-mcp (~/.local/bin) for an in-session MCP check
  4. banner + interactive shell in /workspace: log in, run check-mcp (must PASS), start a
     FRESH agent session and paste the prompt (README "## Prompt" section) as its FIRST message (any experiments, e.g.
     asking for a screenshot, happen before in a separate session or via check-mcp only;
     quit that session first). `finish` checks this in the transcripts (`prompt_check` in
     meta.json against `meta.prompt.text`, whitespace-normalised; Codex's injected
     `<environment_context>`/AGENTS items are skipped; warning if the prompt was not first;
     Claude Code and Codex formats)
  5. exit the shell -> "Finish run now? [Y/n]"
       Y: copy transcripts, commit leftovers, write meta.json, remove the container
       n: keep everything; come back with ./oneshotshop resume <branch>
```

- **Branch name**: `<YYYY-MM-DD>-<agent>-<model-slug>`; the slug is the label in lowercase with
  every run of non-alphanumerics replaced by `-` (`"GLM 5.3"` -> `glm-5-3`). `--suffix x` appends
  `-x` (e.g. a second run of the same model on the same day).
- **Input isolation**: only git-tracked files of `main` reach the agent (`git clone
  --single-branch`); untracked/ignored files (`.env`, `.idea`, scratch) never do. The clone has no
  remote, so the agent cannot fetch other runs. If `main` has no commit, the run aborts.
- **The agent may commit** locally as it likes. It has no GitHub credentials.
- **Wall time** is measured per shell session (shell start to shell exit) and summed
  (`wall_time.active_shell_secs`); `first_start_to_last_exit_secs` spans first start to final
  exit. `agent_first_event` is the earliest timestamp found in the agent's own transcripts
  (best effort). A session whose terminal was closed without the harness noticing is recorded as
  `interrupted` with unknown length.

### Subcommands

| Command | What it does |
|---|---|
| `./oneshotshop <agent> "<label>" [options]` | start a run (see `./oneshotshop --help`) |
| `./oneshotshop resume <branch>` | new shell in the still-running container (HOME, login, tmux sessions intact) |
| `./oneshotshop finish <branch>` | finish without a shell (e.g. after an accidental close) |
| `./oneshotshop push <branch>` | push the finished branch to the spec repo with the host's git credentials |
| `./oneshotshop verify <branch>` | gate check (`verify.sh`) |
| `./oneshotshop evaluate <branch>` | post-run pipeline (see "After the run") |
| `./oneshotshop status <branch>` | evaluation step status, costs, Playwright versions |
| `./oneshotshop serve <branch> [--port N] [--from-remote]` | browse a finished shop on `http://127.0.0.1:<port>/` with the spec logins printed; Ctrl-C stops and cleans up |
| `./oneshotshop list` | all runs with status, agent version, active time, pushed |

Start options: `--suffix`, `--spec <url|path>` (default `git@github.com:tecsteps/oneshotshop.git`,
env `ONESHOTSHOP_SPEC`), `--spec-branch` (`main`), `--cpus` (8), `--memory` (7g), `--timeout <dur>`
(optional: the container stops after that time), `--image <ref>` (default
`oneshotshop-runner:current`), `--with-credentials` (opt-in, see below).

**Fairness — identical limits**: every comparable run uses the standard limits (8 CPUs, 7g).
Starting with other values prints "limits differ from the standard run … results not comparable"
and records `limits.standard: false`. The limits Docker actually applies are read with
`docker inspect` at start and at finish (`limits_effective.start/finish`,
`changed_during_run`), so a `docker update` during a run is visible; `finish` merges into the
existing `meta.json`, so hand-added keys such as a `limit_changes` array are kept.

**Tip**: start `./oneshotshop` inside host tmux (`tmux new -s oss`); `Ctrl-b d` detaches and the
agent keeps working, `tmux attach -t oss` comes back. (The container also has tmux, but don't nest
the two: both use `Ctrl-b`.)

### Testing the plumbing without tokens

`--exec "<cmd>"` runs a command in `/workspace` instead of the interactive shell, and
`--finish` / `--pause` decide what happens afterwards (default: ask; without a TTY: finish).
Installers, MCP registration, meta.json, transcripts and the leftover commit all run for real;
no agent is started, so nothing is spent.

```bash
./oneshotshop claude "test" --spec ../oneshotshop --exec 'claude mcp list' --pause
./oneshotshop resume 2026-10-02-claude-test --exec 'ls -A' --finish
```

## Outputs: `runs/<branch>/` (git-ignored, never committed to the run branch)

| File | Contents |
|---|---|
| `meta.json` | branch, status, agent + installed version, model label/slug, image tag + **id**, spec source/branch/commit/tree, prompt (text, sha256, source `README.md#Prompt @ <commit>`), prompt_check, limits, tool versions (PHP, Composer, Node, npm), Playwright MCP / playwright-core / Chromium versions and the `mcp list` output, sessions, wall time, result (head, base, harness commit, files changed, files left uncommitted), pushed |
| `sessions.jsonl` | one line per shell session (start, end, seconds, exit code, interrupted) |
| `install.log`, `mcp-list.txt` | agent + MCP installation output, the agent's own `mcp list` |
| `transcripts/` | the agent's session files from the container HOME (`AGENT_TRANSCRIPTS` in `agents/<agent>/agent.conf`) plus `~/.bash_history`, keeping their HOME-relative layout: claude `.claude/projects/` (incl. `subagents/`), codex `.codex/sessions/` (all `rollout-*.jsonl`, incl. sub-agents) + `.codex/archived_sessions/` + `.codex/history.jsonl`, cursor `.cursor/chats/` + `.cursor/projects/*/agent-transcripts/`, opencode `.local/share/opencode/` (`opencode.db`, `storage/`). Files named like `auth.json`, `.credentials.json`, `*credential*`, `*token*`, `*.key` are excluded. Input for `eval/insights/insights.sh <branch>` |
| `transcripts/cursor-usage.csv` | **Cursor only, by hand**: Cursor's transcripts carry no tokens/models. Download the usage-events CSV from the Cursor dashboard after the run and save it here; the banner and `finish` remind you. Pass it to insights with `--usage-csv` |
| `workspace/` | the run checkout (branch `<branch>`), left at the run head for `eval/insights` |
| `gate.json`, `gate/logs/` | written by `verify.sh` |

### Leftover commit (on finish)

The harness commits whatever the agent left uncommitted as
`Run <branch>: final state (uncommitted changes)`, but **never** `vendor/`, `node_modules/`,
`.env` or `.env.*` (except `.env.example`), at any depth, even if the agent did not ignore them.
Anything the agent committed itself is left untouched. `meta.json` lists what stayed uncommitted.

## Gate check (strict)

```bash
./oneshotshop verify <branch>                  # fresh clone from runs/<branch>/workspace (what was committed)
./oneshotshop verify <branch> --from-remote    # fresh clone from the spec repo (what was pushed)
```

In a fresh container from **the image id recorded for that run**, on a fresh clone of the branch,
it runs exactly `composer install`, `npm ci`, `npm run build`, `php artisan migrate --seed`
(no TTY), starts `php artisan serve` and waits up to 120s for `GET /` to return 200.
`runs/<branch>/gate.json` holds pass/fail, the failing step, per-step exit codes and durations,
whether a `.env` is in the branch, and a log excerpt. Making a fresh clone runnable (including
any `.env` handling) is the agent's job.

`--env-bootstrap` (create `.env` from `.env.example` + `key:generate`) exists only as a
**diagnostic**; such results carry `"scoring_valid": false` and must never be used for scoring.

## After the run

### Browse the shop: `./oneshotshop serve`

```bash
./oneshotshop serve <branch>                 # -> http://127.0.0.1:8000/ (next free port if busy)
./oneshotshop serve <branch> --port 8080     # another port
./oneshotshop serve <branch> --from-remote   # what was pushed instead of what was committed
```

Starts a **fresh, freshly seeded copy** of the finished shop, built exactly like the gate and the
evaluation see it: fresh clone of the run branch, the run's recorded image id, the README start
command (`composer install`, `npm ci`, `npm run build`, `php artisan migrate --seed`), then
`php artisan serve`. It is published on **127.0.0.1 only** and prints the URL plus the logins from
the branch's own `specs/admin.md` and `specs/customers.md` (admin and three customer accounts)
and the admin sign-in address if the shop's README states one. It runs in the foreground; **Ctrl-C**
stops it and removes the container and its volume (nothing you click changes the run). A good
moment to take screenshots for `runs/<branch>/human/screenshots/`. Only finished runs can be served.

A build that is still running cannot be browsed live: run containers publish no ports, by design.

### Evaluate: `./oneshotshop evaluate`

```bash
./oneshotshop evaluate <branch>                          # all steps, resumable (detached worker, follows the log)
./oneshotshop evaluate <branch> --detach                 # start and return immediately
./oneshotshop evaluate <branch> --from testplan          # re-run testplan and everything after it
./oneshotshop evaluate <branch> --steps human,report     # after writing your impression / adding screenshots
./oneshotshop evaluate <branch> --force                  # re-run every selected step
./oneshotshop status <branch>                            # step table, costs, Playwright versions
```

The run must be finished. `evaluate` always runs as a **detached background worker** (its own
session, output only to `runs/<branch>/evaluate.log`), so a closed or reused terminal, Ctrl-C or
a broken pipe can never kill it or the step runners it calls (a closed terminal once killed a
testplan pass with SIGPIPE). By default the command then follows the log; Ctrl-C or closing the
terminal only stops following. `--detach` returns immediately and prints the log path;
`--foreground` runs in the terminal (debugging only). `./oneshotshop status <branch>` shows
whether an evaluate is RUNNING (pid file `runs/<branch>/evaluate.pid`, or a matching process),
and a second `evaluate` of the same run is refused while one is alive. Recommended for long
passes: `./oneshotshop evaluate <branch> --detach` (or tmux).

On resume, the step runners replace leftovers of an interrupted pass: the testplan runner removes
an existing `oneshotshop-testplan-<branch>-p<N>` container (`docker rm -f`) and starts a fresh app
from a fresh clone, skipping suites that already have a result; perf and tools do the same with
their containers. QA traffic that the interrupted pass did not get to collect is lost (only the
resumed part is captured).

Steps, in order:

| Step | Runs | Output | Notes |
|---|---|---|---|
| `gate` | `verify.sh` | `gate.json` | strict gate; a failing gate is a *result*, not a pipeline error |
| `tools` | `eval/tools/run.sh <branch>` | `tools/summary.json` | always runs; with a failed gate it gets `EVAL_GATE_PASSED=0` (static analysis only, ZAP/axe skipped) |
| `testplan` | `eval/testplan/run.sh <branch> --pass 1` | `testplan/pass-1/{results,score}.json` | **paid**; skipped when the gate failed; a failed Playwright preflight (`preflight.json` with `ok: false`) fails the step with its error |
| `perf` | `eval/perf/run.sh <branch>` | `perf/summary.json` | free (no agent); skipped when the gate failed; runs **after** `testplan` so its aggregation already includes the QA traffic (`perf/qa-*`). If `testplan` is re-run alone while perf is done, `run.sh --aggregate-only` is called automatically. `status` prints a one-line perf headline |
| `insights` | `eval/insights/insights.sh <branch>`, then the analysis command it prints, then `check-insights.mjs` | `insights/insights.json` | **paid**: host `claude -p --model sonnet` with your own Claude Code login, restricted tools as printed, capped by `--max-budget-usd` (`ONESHOTSHOP_INSIGHTS_BUDGET_USD`, default 10); cost from `--output-format json` |
| `human` | creates `human/impression.md` (template) and `human/screenshots/` (README) | your notes | done as soon as `impression.md` differs from the template; never blocks: evaluate prints a reminder and continues |
| `report` | `lib/report.mjs` | `report.json` | everything combined, validated against `eval/report.schema.json`; re-run any time |

- **State**: `runs/<branch>/evaluate.json` (per step: `pending|running|done|failed|skipped`, start,
  finish, duration, cost, error/note). Without flags, `evaluate` skips steps that are `done`
  (except `human` and `report`, which are cheap and always re-checked) and stops at the first
  failure; fix it and run `evaluate` again to resume. Log: `runs/<branch>/evaluate.log`.
- **Costs**: paid steps print a note before they start and record the actual cost
  (`testplan`: `cost_usd` in `score.json` or `cost.json`; `insights`: `total_cost_usd` of the
  analysis run). `status` and `report.json` show per-step costs and the total.
- **Human impression**: fill in `runs/<branch>/human/impression.md` (overall impression, what
  impressed / annoyed you, UX/design, would you use it, optional 1–10 score, free notes). Put
  screenshots in `runs/<branch>/human/screenshots/` as `NN-short-title.png` (`.jpg`/`.webp` work
  too), optional captions in `captions.md` (`01-home.png: caption`). Misnamed files are ignored
  with a warning. Then `./oneshotshop evaluate <branch> --steps human,report`.
- **`report.json`** is the single input for the website step: run metadata (agent, version, model,
  image, spec, prompt, limits, wall time, result), Playwright MCP/Chromium versions (agent and
  evaluator), gate, tools summary, testplan score + per-area counts + results, perf `headline` +
  `stack`, insights,
  human impression (markdown) + screenshots with captions, per-step status/costs and artefact
  paths. Results of steps that are not `done` are left out (`null`), so stale files never leak in.
- Testing without the real step scripts: `ONESHOTSHOP_EVAL_DIR=<dir>` points the pipeline at a
  directory with the same layout (`tools/run.sh`, `testplan/run.sh`, `perf/run.sh`, `insights/…`), and
  `ONESHOTSHOP_CLAUDE_BIN` replaces the `claude` binary.

## The image

`docker/build.sh [tag]` builds `oneshotshop-runner:<tag>` (default: today's date) and moves
`oneshotshop-runner:current` to it. Every run records the exact image id; the gate reuses it.

It is the bare starting point: Debian bookworm, PHP 8.4 CLI (pdo_sqlite, sqlite3, mbstring, xml,
dom, curl, zip, intl, bcmath, gd, fileinfo, tokenizer, opcache, pcntl), Composer 2, Node 22 +
npm, sqlite3, git, curl, unzip, jq, ripgrep, tmux, nano, and the OS libraries Chromium needs
(installed at build time because that needs root). **No coding agent, no Playwright, no MCP
server and no browser are in the image**; they are installed per run into the agent's HOME
(npm prefix `~/.local`), as the non-root user `agent`.

For Linux hosts with a uid other than 1000, build with `--build-arg AGENT_UID=$(id -u)`.

### Browser toolset (identical for building and testing agents)

`lib/playwright-mcp-install.sh` installs the pinned `@playwright/mcp` and its Chromium (the
version is defined once in `lib/versions.sh`; the container install, the image build and the
host-side evaluator all read it), and writes the shared definition to `~/.config/oneshotshop/mcp.json`:

```
/home/agent/.local/bin/playwright-mcp --headless --browser chromium --isolated --output-dir /tmp/playwright-mcp
```

No `--no-sandbox` is needed; `--isolated` keeps the profile in memory; screenshots go to `/tmp`,
not into the workspace. `agents/<agent>/mcp.sh` registers exactly this server in the agent's
user-level config, never in `/workspace`:

| Agent | User-level config | Check |
|---|---|---|
| claude | `~/.claude.json` via `claude mcp add --scope user` | `claude mcp list` |
| codex | `[mcp_servers.playwright]` in `~/.codex/config.toml` | `codex mcp list` |
| cursor | `~/.cursor/mcp.json` | `cursor-agent mcp list` |
| opencode | `~/.config/opencode/opencode.json` | `opencode mcp list` |

The evaluation side uses the same pinned MCP version: the testplan runner installs it (plus its
Chromium) on the host into `eval/testplan/.playwright` via `eval/testplan/runner/playwright-setup.sh`,
reading `lib/versions.sh`, so the testing agent gets an identical browser toolset (see
[`eval/README.md`](eval/README.md)).

## Agents and logins

Credentials are **not** injected by default. In the shell you log in yourself (subscription
logins work; the URL is printed, open it on the host). The banner shows the exact commands:

| Agent | Log in | Start |
|---|---|---|
| claude | `claude`, then `/login` | `claude --dangerously-skip-permissions [--model …]` |
| codex | `codex login --device-auth` | `codex --dangerously-bypass-approvals-and-sandbox [-m …]` |
| cursor | `NO_OPEN_BROWSER=1 cursor-agent login` | `cursor-agent --force --approve-mcps [--model …]` |
| opencode | `opencode auth login` | `opencode [--model provider/model]` |

**Check the browser toolset in-session before pasting the prompt**: after logging in, run
`check-mcp`. It makes one tiny non-interactive call to the agent on your login (a few tokens),
asking it to list its Playwright tools and to navigate to https://example.com with the
Playwright MCP. PASS = the answer names `browser_navigate` and reports the title
"Example Domain"; on FAIL it prints the agent's answer and the likely fix. The per-agent call is
`AGENT_CHECK_CMD` in `agents/<agent>/agent.conf` (codex: `codex exec --skip-git-repo-check
--dangerously-bypass-approvals-and-sandbox "…"`, claude: `claude -p`, cursor: `cursor-agent -p`,
opencode: `opencode run`).

**Codex hardening** (`agents/codex/install.sh`, via the CLI's own `codex features disable`, written
to `[features]` in `~/.codex/config.toml`): `apps`, `plugins`, `remote_plugin` and
`plugin_sharing` are off, so ChatGPT Apps/connectors (e.g. `mcp__codex_apps__sites_*`, which can
build and deploy sites through your ChatGPT account) never enter an isolated run; `browser_use`,
`browser_use_external` and `computer_use` are off, so Codex uses the same Playwright MCP as every
other agent. Edit `DISABLE=` there to change the list; `codex features list` inside the container
shows the effective state. The Playwright server is written directly into `config.toml` with the
absolute binary path (`~/.local/bin/playwright-mcp`, no npx at session start),
`startup_timeout_sec = 60` and `tool_timeout_sec = 120`.

Opt-in: `--with-credentials` passes exactly **one** variable from the agent's
`AGENT_CREDENTIALS` list (the first one set in the environment or `.env`) into the container, by
name only (`docker create -e VAR`). See `.env.example`. Deployment secrets such as
`FORGE_TOKEN` are never candidates and never enter a container.

### Add an agent (kimi, deepseek, gemini, …)

Create `agents/<name>/` with three files:

- `agent.conf` (sourced by the host):
  ```bash
  AGENT_TITLE="Gemini CLI"
  AGENT_VERSION_CMD="gemini --version"
  AGENT_START="gemini --yolo [--model …]"
  AGENT_LOGIN="gemini, then choose 'Login with Google' (or --with-credentials: GEMINI_API_KEY)"
  AGENT_MCP_LIST="gemini mcp list"
  AGENT_TRANSCRIPTS=".gemini/tmp"          # paths under $HOME copied to transcripts/
  AGENT_CREDENTIALS="GEMINI_API_KEY"       # opt-in only
  AGENT_CHECK_CMD='gemini -p "$Q" --yolo > "$OUT"'   # check-mcp: answer to $Q must go to $OUT
  AGENT_CHECK_HINT="gemini mcp list; logged in?"
  ```
- `install.sh`: installs the latest CLI as user `agent` into `~/.local` (e.g.
  `npm install -g @google/gemini-cli`, or the vendor's curl installer), no root.
- `mcp.sh`: reads `~/.config/oneshotshop/mcp.json` and registers that server in the CLI's
  user-level config (its `mcp add` command, or its config file under `$HOME`).

Then test without tokens:
`./oneshotshop <name> "test" --spec ../oneshotshop --exec '<name> mcp list' --finish`.

## Prerequisites

- Docker Desktop. Give the VM enough resources (Settings > Resources); the defaults are
  `--cpus 8 --memory 7g` (the standard run, fits a ~7.75 GB VM) and the harness warns when the
  VM is smaller.
- Host: `bash`, `git`, `jq`, `shasum` (all on macOS), Node ≥ 18 (`report`, `insights`), and
  Claude Code logged in (paid `evaluate` steps). Push access to the spec repo for `push`.

## Secrets: `.env`

The harness's own secrets live in the git-ignored `.env` in the harness root (`.env.example`
lists the keys). It is never printed, copied, mounted or committed. Only `--with-credentials`
reads one agent credential from it.

## Security notes

- The container runs as non-root `agent` with `--cap-drop ALL`, `no-new-privileges`, a pids limit
  and CPU/memory limits; no privileged flags, no docker socket. The only host mount is the run's
  own workspace clone. Installer, MCP and gate scripts are piped in on stdin and never stored in
  the container; nothing from the harness directory is mounted.
- Inside the container the agent is meant to run unrestricted (skip-permissions / yolo modes):
  it can wreck `/workspace` and its own HOME, nothing else. Network is open (packages, model APIs).
- Logins and any opted-in credential are readable by the agent. Use dedicated, revocable
  accounts/keys with spending limits for benchmark runs.
- **Transcripts can contain secrets** (an agent may print its environment; `~/.bash_history`
  contains what you typed). Obvious credential files are excluded, but review
  `runs/<branch>/transcripts/` before publishing anything. `runs/` is git-ignored.
- Pushing happens only through `./oneshotshop push` on the host. The repo is public: check the
  branch (e.g. for a committed `.env` with real keys) before pushing.

## Layout

```
oneshotshop                      entry point (start, resume, finish, push, verify, list)
verify.sh                        strict gate check
agents/<agent>/                  agent.conf, install.sh, mcp.sh  (claude, codex, cursor, opencode)
docker/Dockerfile, build.sh      the bare run image
lib/playwright-mcp-install.sh    pinned Playwright MCP + Chromium (building and evaluation)
lib/gate.sh                      gate steps (runs inside the gate container)
lib/evaluate.sh, report.mjs      post-run pipeline + report builder
lib/serve.sh                     ./oneshotshop serve (reuses eval/tools/scripts/prepare-app.sh)
lib/schema-validate.mjs          dependency-free JSON Schema check (report.json)
lib/templates/                   human impression + screenshots README templates
lib/versions.sh                  pinned versions (Playwright MCP, Chromium OS deps)
eval/report.schema.json          schema of runs/<branch>/report.json
lib/common.sh                    host helpers
eval/                            evaluation steps (overview: eval/README.md)
  tools/, testplan/, perf/, insights/   one folder per step, each with its own docs
deploy/                          Hetzner deployment of all shops (later)
```
