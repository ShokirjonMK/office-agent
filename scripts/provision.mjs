#!/usr/bin/env node
// Provision the IT-firm agent team inside a running Paperclip instance.
// Idempotent: safe to run repeatedly. Resolves the company dynamically,
// (re)builds the org chart, and configures agents for continuous "loop" work.
//
// Env:
//   PAPERCLIP_API      default http://127.0.0.1:3100/api
//   COMPANY            company UUID, issue-prefix, or name (default: first company)
//   HEARTBEAT_MS       agent loop interval hint (default 30000)

const API = (process.env.PAPERCLIP_API || "http://127.0.0.1:3100/api").replace(/\/$/, "");
const COMPANY_HINT = process.env.COMPANY || "";
const HEARTBEAT_MS = parseInt(process.env.HEARTBEAT_MS || "30000", 10);

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
  if (!r.ok) throw new Error(`POST ${p} -> ${r.status}: ${t.slice(0, 300)}`);
  return t ? JSON.parse(t) : null;
}

async function waitForApi(tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const h = await get("/health");
      if (h?.status === "ok" || h?.authReady) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Paperclip API not reachable at ${API} after ${tries * 2}s`);
}

async function resolveCompany() {
  const companies = await get("/companies");
  if (Array.isArray(companies) && companies.length) {
    if (COMPANY_HINT) {
      const m = companies.find(
        (c) => c.id === COMPANY_HINT || c.issuePrefix === COMPANY_HINT || c.name === COMPANY_HINT,
      );
      if (m) return m;
    }
    return companies[0];
  }
  // No company yet — create one (trusted-local mode).
  console.log("No company found — creating 'Office Agent'…");
  return post("/companies", {
    name: COMPANY_HINT || "Office Agent",
    defaultResponsibleUserId: "local-board",
  });
}

const baseAdapter = {
  adapterType: "claude_local",
  adapterConfig: { dangerouslySkipPermissions: true, maxTurnsPerRun: 1000 },
  // runtimeConfig.heartbeat keeps the agent looping: it wakes on the heartbeat,
  // checks for assigned work, acts, and goes idle again — repeat forever.
  runtimeConfig: { heartbeat: { maxConcurrentRuns: 5 } },
};

// key -> definition. boss references an earlier key, or "CEO" for the root.
const TEAM = [
  { key: "CEO",    name: "CEO",                  role: "ceo",      icon: "crown",      boss: null,   cap: "Runs the company. Sets goals, approves strategy, delegates to CTO and Product Manager, and keeps everyone aligned to the mission." },
  { key: "CTO",    name: "CTO",                  role: "cto",      icon: "cpu",        boss: "CEO",  cap: "Owns technical strategy and architecture. Delegates to Team Lead, DevOps, and Security." },
  { key: "PM",     name: "Product Manager",      role: "pm",       icon: "target",     boss: "CEO",  cap: "Owns roadmap, requirements, priorities. Turns goals into well-scoped issues and coordinates Design + Engineering." },
  { key: "DESIGN", name: "Designer",             role: "designer", icon: "wand",       boss: "PM",   cap: "Owns UX/UI, wireframes, design system, visual polish. Hands specs to Frontend." },
  { key: "LEAD",   name: "Team Lead",            role: "engineer", icon: "star",       boss: "CTO",  cap: "Leads the dev team, breaks work into tasks, reviews code, unblocks devs, reports to CTO." },
  { key: "FE",     name: "Frontend Dev",         role: "engineer", icon: "code",       boss: "LEAD", cap: "Builds UI/frontend, implements designs, client-side state and API integration." },
  { key: "BE",     name: "Backend Dev",          role: "engineer", icon: "database",   boss: "LEAD", cap: "Builds backend/APIs, data models, business logic, auth, integrations." },
  { key: "FS",     name: "Full-stack Dev",       role: "engineer", icon: "hexagon",    boss: "LEAD", cap: "Ships end-to-end features across frontend and backend; fills gaps." },
  { key: "QA",     name: "QA Engineer",          role: "qa",       icon: "bug",        boss: "LEAD", cap: "Writes/runs tests, verifies features end-to-end, reproduces bugs, gates releases." },
  { key: "REFA",   name: "Refactoring Engineer", role: "engineer", icon: "wrench",     boss: "LEAD", cap: "Improves code quality: refactors, removes duplication, simplifies, enforces patterns." },
  { key: "DEVOPS", name: "DevOps Engineer",      role: "devops",   icon: "git-branch", boss: "CTO",  cap: "Owns CI/CD, builds, deployments, environments, containers, infra reliability." },
  { key: "SEC",    name: "Security Engineer",    role: "security", icon: "shield",     boss: "CTO",  cap: "Owns security review, threat modeling, dependency/secret hygiene, hardening." },
];

async function main() {
  await waitForApi();
  const company = await resolveCompany();
  const CID = company.id;
  console.log(`Company: ${company.name} (${CID}) prefix=${company.issuePrefix ?? "?"}`);

  const existing = await get(`/companies/${CID}/agents`);
  const byName = new Map((existing || []).map((a) => [a.name.toLowerCase(), a]));
  const ids = {};

  // Reuse an existing ceo-role agent (e.g. onboarding's "Chief of staff") as CEO root.
  const existingCeo = (existing || []).find((a) => a.role === "ceo" && a.reportsTo == null);

  for (const m of TEAM) {
    const bossId = m.boss ? ids[m.boss] : null;
    let agent = byName.get(m.name.toLowerCase());
    if (!agent && m.key === "CEO" && existingCeo) agent = existingCeo; // adopt onboarding CEO
    if (agent) {
      ids[m.key] = agent.id;
      console.log(`= ${m.name.padEnd(22)} exists [${agent.status}]`);
    } else {
      agent = await post(`/companies/${CID}/agents`, {
        name: m.name, role: m.role, title: m.name, icon: m.icon,
        reportsTo: bossId ?? undefined, capabilities: m.cap, ...baseAdapter,
      });
      ids[m.key] = agent.id;
      console.log(`+ ${m.name.padEnd(22)} created [${agent.status}] -> ${m.boss ?? "root"}`);
    }
    // Make sure it's active (clear error / resume paused) so the loop runs.
    const fresh = await get(`/agents/${agent.id}`).catch(() => agent);
    if (fresh.status === "error") await post(`/agents/${agent.id}/clear-error`, {}).catch(() => {});
    if (fresh.status === "paused" || fresh.status === "error") await post(`/agents/${agent.id}/resume`, {}).catch(() => {});
  }

  console.log(`\n✅ Team ready: ${TEAM.length} roles under ${company.name}.`);
  console.log(`   Agents loop via Paperclip heartbeats (~${HEARTBEAT_MS}ms): each wake checks for`);
  console.log(`   assigned work and acts, then idles — repeat forever. Assign a goal to the CEO/PM`);
  console.log(`   (office chat or dashboard) and work flows down the org chart automatically.`);
}

main().catch((e) => { console.error("provision failed:", e.message); process.exit(1); });
