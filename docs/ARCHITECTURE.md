# Architecture

```
                 ┌───────────────────────────┐
   your goal ──► │  Paperclip  (the brain)   │  :3100
                 │  org chart · tasks ·      │  REST API + embedded Postgres
                 │  budgets · heartbeats     │  agents = Claude Code (local ACP)
                 └────────────┬──────────────┘
                              │ REST (agents, issues, heartbeat/invoke)
                              ▼
                 ┌───────────────────────────┐
                 │  bridge (this repo)       │  ws://…:18789
                 │  paperclip-gateway-       │  speaks Claw3D's gateway
                 │  adapter.js               │  protocol, sources real agents
                 └────────────┬──────────────┘
                              │ WebSocket (gateway protocol v3)
                              ▼
                 ┌───────────────────────────┐
                 │  Claw3D  (the office)     │  :3000
                 │  3D workspace, chat,      │  renders agents as workers
                 │  fleet, approvals         │
                 └───────────────────────────┘
```

## The bridge

`bridge/paperclip-gateway-adapter.js` is a small WebSocket server that implements
the same **gateway protocol (v3)** Claw3D's bundled demo gateway uses, but instead
of hard-coded demo agents it:

- **Reads the live roster** from Paperclip's REST API
  (`GET /companies/<id>/agents`) and refreshes every 5s.
- Maps each Paperclip agent → an office worker (id, name, role, emoji from its icon).
- On `chat.send`, **creates a real Paperclip issue** assigned to that agent
  (`POST /companies/<id>/issues`) and **wakes it** (`POST /agents/<id>/heartbeat/invoke`),
  then streams back a confirmation.

### The `openclaw` trick

Claw3D treats a gateway whose hello advertises `adapterType: "demo"` as a demo:
it stays in the lobby and seeds a single local "main" agent, ignoring the roster
(`OfficeScreen.tsx` gates on this). To make the office leave the lobby and hydrate
the **real** multi-agent roster, the bridge advertises `adapterType: "openclaw"`.
`setup.sh` also writes `CLAW3D_GATEWAY_URL=ws://localhost:18789` +
`CLAW3D_GATEWAY_ADAPTER_TYPE=openclaw` into Claw3D's `.env` so the connect screen
pre-selects the OpenClaw backend at the right URL.

## The Windows patch

Paperclip's local ACP engine (`packages/adapter-utils/src/acpx-engine/execute.ts`)
writes a bash `.sh` wrapper per agent and assumes a POSIX host. The bundled `acpx`
runtime can only spawn `.exe/.cmd/.bat` and parses the agent command with a
shell-style splitter (backslash = escape, preserved only inside single quotes), so
on Windows a `.sh` path fails with *"Failed to spawn agent command … .sh"* and its
backslashes get eaten.

`scripts/apply-windows-patch.mjs` makes `writeAgentWrapper` return a
**single-quoted** command instead of the raw path:

```
'C:\Program Files\Git\bin\bash.exe' '<…>\wrapper.sh'
```

Single quotes survive the splitter, `bash.exe` (a real `.exe`) spawns directly
(no fragile Windows `shell:true`), and Git Bash runs the wrapper which sources the
env and execs the real ACP agent. No-op on Linux/macOS, where `.sh` runs natively.

## The loop

Paperclip runs a **heartbeat** (~30s). Each tick, every eligible agent wakes,
checks for assigned/queued work, acts (one Claude Code run), records cost + logs,
and idles. That *is* the loop — no external scheduler. `provision.mjs` sets each
agent's `runtimeConfig.heartbeat` and ensures they're active (not paused), so the
whole firm keeps pulling work as it arrives.

Parallelism scales with the backlog: more delegated issues → more agents running
at once (up to each agent's `maxConcurrentRuns`).

## Optional: an autoscaler

Native Paperclip has a **fixed roster** that runs in parallel — it does not create
new agents under load. If you want the roster itself to grow (e.g. spin up extra
"Backend Dev #2/#3" when the backend backlog is deep), add a small loop that:

1. Polls open issues per role/label (`GET /companies/<id>/issues`).
2. When a role's queue exceeds a threshold, clones that agent via
   `POST /companies/<id>/agents` (same adapter, `reportsTo` the Team Lead).
3. Scales back down (pause/delete) when the queue drains.

The bridge already refreshes every 5s, so any agents an autoscaler adds show up in
the office automatically. This is intentionally left as an opt-in extension.
```
