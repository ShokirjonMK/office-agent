#!/usr/bin/env node
// Dynamic autoscaler: grows/shrinks a pool of worker agents to match the backlog.
//
// It watches the company's open (non-terminal) issues and keeps the number of
// "autoscaled" worker agents between MIN and MAX, targeting ~PER_AGENT open
// issues per worker. New workers are cloned from a template (an engineer under
// the Team Lead) and tagged metadata.autoscaled=true so only they are managed.
// The bridge refreshes every 5s, so scaled agents appear/disappear in the office
// automatically.
//
// Env:
//   PAPERCLIP_API        default http://127.0.0.1:3100/api
//   COMPANY              company UUID / prefix / name (default: first)
//   AUTOSCALE_MIN        min pool size (default 0)
//   AUTOSCALE_MAX        max pool size (default 5)
//   AUTOSCALE_PER_AGENT  open issues per worker before scaling up (default 3)
//   AUTOSCALE_INTERVAL_MS poll interval (default 20000)
//   AUTOSCALE_COOLDOWN   consecutive idle cycles before removing a worker (default 3)
//   DRY_RUN=1            log decisions without creating/removing agents
//   ONCE=1               run a single cycle and exit (useful for testing)

const API = (process.env.PAPERCLIP_API || "http://127.0.0.1:3100/api").replace(/\/$/, "");
const COMPANY_HINT = process.env.COMPANY || process.env.PAPERCLIP_COMPANY || "";
const MIN = int("AUTOSCALE_MIN", 0);
const MAX = int("AUTOSCALE_MAX", 5);
const PER_AGENT = Math.max(1, int("AUTOSCALE_PER_AGENT", 3));
const INTERVAL_MS = int("AUTOSCALE_INTERVAL_MS", 20000);
const COOLDOWN = int("AUTOSCALE_COOLDOWN", 3);
const DRY_RUN = process.env.DRY_RUN === "1";
const ONCE = process.env.ONCE === "1";

const TERMINAL = new Set(["done", "closed", "cancelled", "canceled", "in_review", "archived"]);
const POOL_TAG = "engineer-pool";

function int(name, def) {
  const v = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) ? v : def;
}
async function get(p) {
  const r = await fetch(`${API}${p}`, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`GET ${p} -> ${r.status}`);
  return r.json();
}
async function post(p, body) {
  const r = await fetch(`${API}${p}`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`POST ${p} -> ${r.status}: ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
}

async function resolveCompany() {
  const companies = await get("/companies");
  if (!Array.isArray(companies) || !companies.length) throw new Error("no company found");
  if (COMPANY_HINT) {
    const m = companies.find((c) => c.id === COMPANY_HINT || c.issuePrefix === COMPANY_HINT || c.name === COMPANY_HINT);
    if (m) return m;
  }
  return companies[0];
}

const idleStreak = new Map(); // agentId -> consecutive idle cycles

async function cycle(cid, teamLeadId) {
  const [issues, agents] = await Promise.all([
    get(`/companies/${cid}/issues`).catch(() => []),
    get(`/companies/${cid}/agents`).catch(() => []),
  ]);
  const issueArr = Array.isArray(issues) ? issues : issues?.issues ?? [];
  const backlog = issueArr.filter((i) => !TERMINAL.has(String(i.status || "").toLowerCase())).length;

  const pool = agents.filter((a) => a?.metadata?.autoscaled === true || a?.metadata?.pool === POOL_TAG);
  const desired = Math.min(MAX, Math.max(MIN, Math.ceil(backlog / PER_AGENT)));

  console.log(`[autoscale] backlog=${backlog} pool=${pool.length} desired=${desired} (min=${MIN} max=${MAX} per=${PER_AGENT})`);

  if (desired > pool.length) {
    const toAdd = desired - pool.length;
    for (let n = 0; n < toAdd; n++) {
      const idx = pool.length + n + 1;
      const name = `Backend Dev #${idx + 1}`;
      if (DRY_RUN) { console.log(`  + would create ${name}`); continue; }
      try {
        const a = await post(`/companies/${cid}/agents`, {
          name, role: "engineer", title: name, icon: "database",
          reportsTo: teamLeadId ?? undefined,
          capabilities: "Auto-scaled engineer: picks up backend/general implementation tasks when the backlog is deep.",
          adapterType: "claude_local",
          adapterConfig: { dangerouslySkipPermissions: true, maxTurnsPerRun: 1000 },
          runtimeConfig: { heartbeat: { maxConcurrentRuns: 5 } },
          metadata: { autoscaled: true, pool: POOL_TAG },
        });
        console.log(`  + created ${name} (${a.id.slice(0, 8)})`);
      } catch (e) { console.error(`  ! create failed: ${e.message}`); }
    }
  } else if (desired < pool.length) {
    // Remove idle extras that have been idle for COOLDOWN cycles (newest first).
    const removable = pool
      .filter((a) => a.status === "idle" || a.status === "paused")
      .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
    let need = pool.length - desired;
    for (const a of removable) {
      if (need <= 0) break;
      const streak = (idleStreak.get(a.id) || 0) + 1;
      idleStreak.set(a.id, streak);
      if (streak < COOLDOWN) { console.log(`  · ${a.name} idle ${streak}/${COOLDOWN}`); continue; }
      if (DRY_RUN) { console.log(`  - would remove ${a.name}`); need--; continue; }
      try {
        await post(`/agents/${a.id}/pause`, { reason: "autoscale scale-down" }).catch(() => {});
        await fetch(`${API}/agents/${a.id}`, { method: "DELETE" }).catch(() => {});
        idleStreak.delete(a.id);
        console.log(`  - removed ${a.name}`);
        need--;
      } catch (e) { console.error(`  ! remove failed: ${e.message}`); }
    }
  } else {
    // steady state — reset idle streaks for busy agents
    for (const a of pool) if (a.status === "running") idleStreak.delete(a.id);
  }
}

async function main() {
  const company = await resolveCompany();
  const cid = company.id;
  const agents = await get(`/companies/${cid}/agents`).catch(() => []);
  const lead = agents.find((a) => a.title === "Team Lead" || (a.role === "engineer" && a.name === "Team Lead"));
  console.log(`[autoscale] company=${company.name} teamLead=${lead ? lead.id.slice(0, 8) : "(none)"} dryRun=${DRY_RUN}`);

  await cycle(cid, lead?.id);
  if (ONCE) return;
  setInterval(() => cycle(cid, lead?.id).catch((e) => console.error("[autoscale] cycle error:", e.message)), INTERVAL_MS);
}

main().catch((e) => { console.error("[autoscale] fatal:", e.message); process.exit(1); });
