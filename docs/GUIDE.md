# office-agent — Full Usage Guide

How to launch the whole stack and run it against **your own projects** — one repo
or many. Covers Docker and bare-metal, Claude authentication, connecting and
switching between project folders/repos, assigning work, the delegation pipeline,
the Telegram bot, and the autoscaler.

- [1. What you get](#1-what-you-get)
- [2. Prerequisites](#2-prerequisites)
- [3. Claude authentication (read this)](#3-claude-authentication-read-this)
- [4. Launch](#4-launch)
- [5. Verify it's up](#5-verify-its-up)
- [6. Projects — connect and switch folders/repos](#6-projects--connect-and-switch-foldersrepos)
- [7. Assigning work + the pipeline](#7-assigning-work--the-pipeline)
- [8. Control from Telegram](#8-control-from-telegram)
- [9. Autoscaler](#9-autoscaler)
- [10. Managing agents](#10-managing-agents)
- [11. Troubleshooting](#11-troubleshooting)

---

## 1. What you get

A self-hosted AI software firm: **Paperclip** (orchestration/dashboard, `:3100`),
**Claw3D** (3D office, `:3000`), a **bridge** that shows the real agents in the
office, a ready-made **13-role team** (CEO, CTO, PM, Team Lead, Senior/Frontend/
Backend/Full-stack Engineers, QA, Refactoring, DevOps, Security, Designer), an
optional **autoscaler**, and an optional **Telegram bot**.

Work is tracked as issues. You give a goal to the **Product Manager**; it
decomposes and delegates down the org chart; QA verifies (bouncing failures back);
the PM reports. The 3D office and dashboard show it live.

---

## 2. Prerequisites

- **Docker** (recommended) — or Node.js 20+, git, bash for bare-metal.
- A **Claude Code** login or API key (see §3).
- ~7 GB disk for the Docker image (or ~3 GB for a bare-metal install).

---

## 3. Claude authentication (read this)

Agents run **Claude Code**. Give it credentials **one** of two ways:

### Option A — Subscription login (Max/Team/Pro, no API key)

Mount your host `~/.claude` into the container (enabled by default in
`docker-compose.yml`). Log in once on the host first:

```bash
claude   # then /login, open the link, paste the code
```

> **⚠️ Org policy gotcha.** Some Team/Enterprise orgs **disable** "Claude Code
> subscription access". If agents fail with
> *"Your organization has disabled Claude subscription access for Claude Code"*,
> a **workspace/org admin** must enable Claude Code access in the Anthropic
> org settings — it is not a code setting. Until then use Option B.
>
> **File-permission gotcha.** Claude ignores a credentials file that is world-
> readable. If a mounted `~/.claude/.credentials.json` shows as `0777`, copy it
> to a `0600` file and point `HOME` at it (the Docker entrypoint can do this).

### Option B — API key

Put `ANTHROPIC_API_KEY=sk-ant-...` in a `.env` file next to `docker-compose.yml`.
This bypasses the subscription org policy entirely.

Either way, the infrastructure (dashboard, office, Telegram, task creation) runs
without credentials; only the agents **executing** work needs them.

---

## 4. Launch

### Docker (recommended, works on any Linux server)

```bash
git clone https://github.com/ShokirjonMK/office-agent.git
cd office-agent
cp .env.example .env         # optional — edit ports / autoscale / Telegram
docker compose up -d --build # first build ~10 min; boots into a ready firm
```

- Office: <http://localhost:3000> · Dashboard: <http://localhost:3100>
- Data (company, agents, DB) persists in the `office_data` volume.
- On a remote server, open the same ports (firewall) and browse to
  `http://SERVER_IP:3000`.

### Bare-metal (Linux/macOS/Windows-Git-Bash)

```bash
git clone https://github.com/ShokirjonMK/office-agent.git
cd office-agent
./scripts/setup.sh    # clone + install Paperclip & Claw3D, wire the bridge
./scripts/start.sh    # start everything + provision the team
./scripts/stop.sh     # stop everything
```

Logs land in `logs/`, PIDs in `run/`.

---

## 5. Verify it's up

```bash
curl -s http://localhost:3100/api/health          # {"status":"ok",...}
curl -s http://localhost:3000 -o /dev/null -w '%{http_code}\n'   # 200/307
```

Open the office, click the connection chip → **OpenClaw backend** (URL
`ws://localhost:18789` is pre-filled) → **Connect**. Your team appears on the
**OpenClaw Floor**. The dashboard lists the same agents, tasks, and budgets.

---

## 6. Projects — connect and switch folders/repos

Agents write code **inside a project workspace**. You can register **many**
projects and point each task at the right one.

A workspace `sourceType` is one of: `git_repo`, `local_path`, `remote_managed`,
`non_git_path`.

### Create a project

**Dashboard:** *Projects → New Project → add a Workspace* (git URL or local path).

**API — git repo:**
```bash
curl -X POST http://localhost:3100/api/companies/<COMPANY_ID>/projects \
  -H 'content-type: application/json' -d '{
    "name": "LMS",
    "workspace": { "name": "main", "sourceType": "git_repo",
                   "repoUrl": "https://github.com/you/lms.git", "repoRef": "main" }
  }'
```

**API — local folder** (a path the container/host can see — mount it into the
container if using Docker):
```bash
curl -X POST http://localhost:3100/api/companies/<COMPANY_ID>/projects \
  -H 'content-type: application/json' -d '{
    "name": "My App",
    "workspace": { "name": "main", "sourceType": "local_path", "cwd": "/home/node/work/myapp" }
  }'
```

> Find `<COMPANY_ID>`: `curl -s http://localhost:3100/api/companies` → first `id`.

### Use / switch between projects

- **Dashboard:** when creating a task, pick the **Project**.
- **API:** add `"projectId": "<PROJECT_ID>"` to the issue body (see §7).
- **Telegram:** `/projects` to list, `/use <name>` to select the active project;
  every new task then targets it. `/newproject <name> | <repoUrl>` creates one.

So "run the firm against **project A**, then **project B**" is just: pick the
project (dashboard dropdown, `projectId`, or `/use`) before you file the task.

### Mounting a local folder into Docker

To let agents work on a folder from your host, mount it in `docker-compose.yml`:
```yaml
    volumes:
      - /abs/path/on/host/myapp:/home/node/work/myapp
```
then register it as a `local_path` project with `cwd: /home/node/work/myapp`.

---

## 7. Assigning work + the pipeline

**Give the goal to the Product Manager (or CEO)** — not to a single dev. Three ways:

1. **Office chat** (`:3000` → CHAT → pick *Product Manager*) — type the goal.
2. **Dashboard** (`:3100` → New Task) — assign to *Product Manager*, set the project.
3. **Telegram** — send the goal (see §8).

### What happens (the loop)

```
CEO ─▶ Product Manager
Product Manager ─▶ splits into child issues, assigns to Team Lead / engineers
                   + a QA-verification issue blocked by them
Team Lead ─▶ routes each piece to Senior / Frontend / Backend / Full-stack
Engineers ─▶ implement in the project workspace, mark done with notes
QA ─▶ verifies:  PASS → done (unblocks parent)
                 FAIL → bounce-back child issue to the dev  ⟲ (the quality loop)
Product Manager ─▶ when all done + QA passed, writes the final report
```

Agents run on Paperclip **heartbeats** (~30s): each wake, they pick up assigned
work, act, and idle — repeat. Watch it in the office and the dashboard.

> This is Paperclip's native management design plus per-role operating procedures
> — it is **emergent** (LLM-driven), not a rigid state machine. Give clear goals
> and acceptance criteria for best results.

**API to file a task at a project:**
```bash
curl -X POST http://localhost:3100/api/companies/<COMPANY_ID>/issues \
  -H 'content-type: application/json' -d '{
    "title": "Add a students-count widget to the LMS home page",
    "description": "...acceptance criteria...",
    "assigneeAgentId": "<PRODUCT_MANAGER_ID>",
    "projectId": "<PROJECT_ID>",
    "responsibleUserId": "local-board"
  }'
```

---

## 8. Control from Telegram

Set in `.env` (or compose env):
```
TELEGRAM_BOT_TOKEN=...   # from @BotFather
TELEGRAM_OWNER_ID=...    # your id from @userinfobot
```
Restart. The bot messages you when online. Commands:

| Command | Does |
|---|---|
| *(any text)* / `/task <text>` | new task for the PM (targets the active project) |
| `/projects` | list projects (▶︎ = active) |
| `/use <name>` | pick the active project |
| `/newproject <name> \| <repoUrl>` | create a git-backed project |
| `/tasks` | open tasks + status |
| `/agents` | roster + status |
| `/whoami`, `/help` | — |

---

## 9. Autoscaler

Grow/shrink a pool of extra engineers with the backlog:
```bash
AUTOSCALE=1 AUTOSCALE_MAX=8 AUTOSCALE_PER_AGENT=3 ./scripts/start.sh
# or AUTOSCALE=1 in .env / docker-compose
```
It keeps ~one extra worker per `AUTOSCALE_PER_AGENT` open issues (between MIN and
MAX), adds them under the Team Lead, and removes idle extras after a cooldown.
They appear/disappear in the office automatically.

---

## 10. Managing agents

- **Add a role:** edit the `TEAM` list in `scripts/provision.mjs` and re-run
  `node scripts/provision.mjs` (idempotent), or `POST /companies/<id>/agents`.
- **Pause / resume / clear error:** dashboard, or
  `POST /agents/<id>/{pause,resume,clear-error}`.
- **An agent in `error`** usually means a failed run (often Claude auth — see §3).
  Clear it, fix auth, and it returns to the loop.
- The two built-in agents (**Reflection Coach**, **Summarizer**) ship paused;
  enable them from the dashboard if you want them.

---

## 11. Troubleshooting

| Symptom | Fix |
|---|---|
| `organization has disabled Claude subscription access` | Org admin enables Claude Code access, or use `ANTHROPIC_API_KEY` (§3). |
| Agent `error` right after a run | Almost always auth (§3). Clear the error, fix auth. |
| Office shows only "Main" / 1 agent | You're on the **Demo** floor — connect the **OpenClaw** backend (§5). |
| Office "Disconnected" | Click Connect again (URL is pre-filled). |
| Host can't reach `:3000/:3100` in Docker | Services bind container-loopback; the image re-exposes them via socat on 8000/8100 (compose maps `3000:8000`, `3100:8100`). Use the compose file. |
| `pnpm` version error (bare-metal) | Paperclip needs exactly `9.15.4`; `setup.sh` pins it. Re-run setup. |
| Nothing at `:3100` on first boot | DB migrations run on first start (~30s). Check `logs/paperclip.log` or `docker logs`. |
| Windows bare-metal: agents fail to spawn | `setup.sh` applies a Git-Bash wrapper patch; ensure Git Bash is installed (or set `PAPERCLIP_GIT_BASH`). |

See also [ARCHITECTURE.md](ARCHITECTURE.md) for how the pieces fit together.
