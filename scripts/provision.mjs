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
  return send("POST", p, body);
}
async function send(method, p, body) {
  const r = await fetch(`${API}${p}`, {
    method,
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${p} -> ${r.status}: ${t.slice(0, 300)}`);
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

// key -> definition. boss references an earlier key, or null for the root.
// `cap` (capabilities) doubles as each agent's operating procedure and encodes
// the automatic pipeline: CEO -> PM -> Team Lead/devs -> QA (loop) -> PM report.
// Paperclip's managed instructions already grant the delegation tools (create
// child issue, assign, comment, set status, add blockers); these caps tell each
// role how to use them. Delegate DOWN the reporting line, report UP.
const TEAM = [
  { key: "CEO",    name: "CEO",                  role: "ceo",      icon: "crown",      boss: null,   cap: "Runs the company. When given a high-level goal, do NOT implement it: create one child issue for the goal, assign it to the Product Manager, and blockParentUntilDone. Review the PM's final report and close the goal. Steer, don't code." },
  { key: "CTO",    name: "CTO",                  role: "cto",      icon: "cpu",        boss: "CEO",  cap: "Owns architecture and technical direction. Route technical work to the Team Lead, DevOps, or Security via assigned child issues; keep the tech coherent; report up to the CEO." },
  { key: "PM",     name: "Product Manager",      role: "pm",       icon: "target",     boss: "CEO",  cap: "When assigned a goal: (1) break it into implementation subtasks — one child issue each, with acceptance criteria, assigned to the Team Lead (or the right engineer), blockParentUntilDone; (2) create a final QA-verification child issue assigned to the QA Engineer, blocked by all implementation issues; (3) do NOT code — monitor status; (4) when all children are done and QA passed, write a concise final report comment on the parent and mark it done. If QA bounced work back, wait for the re-work first." },
  { key: "DESIGN", name: "Designer",             role: "designer", icon: "wand",       boss: "PM",   cap: "Produces UX/UI specs and design notes for assigned issues, then hands them to the Frontend Dev via an assigned child issue. Marks the issue done once the spec is delivered." },
  { key: "LEAD",   name: "Team Lead",            role: "engineer", icon: "crown",      boss: "CTO",  cap: "When assigned an implementation issue, split it into child issues and assign each to the right engineer — Senior (hard/cross-cutting), Frontend (UI), Backend (API/data), Full-stack (end-to-end). Review completed work, unblock engineers, report status up to the PM. Minimal coding yourself." },
  { key: "SR",     name: "Senior Engineer",      role: "engineer", icon: "star",       boss: "LEAD", cap: "Takes the hardest / cross-cutting implementation issues, mentors and unblocks other devs, and does code review before QA. Implements in the workspace, verifies against acceptance criteria, marks done with notes, and sets technical patterns for the team." },
  { key: "FE",     name: "Frontend Dev",         role: "engineer", icon: "code",       boss: "LEAD", cap: "Implements assigned UI/frontend issues in the project workspace: write/modify code, run it, verify against acceptance criteria, then mark the issue done with a comment on what changed and how you tested. Comment blockers instead of guessing." },
  { key: "BE",     name: "Backend Dev",          role: "engineer", icon: "database",   boss: "LEAD", cap: "Implements assigned backend/API/data/business-logic issues in the workspace, runs and verifies them, then marks the issue done with a comment on what changed and how tested. Comment blockers instead of guessing." },
  { key: "FS",     name: "Full-stack Dev",       role: "engineer", icon: "hexagon",    boss: "LEAD", cap: "Takes end-to-end feature issues across frontend and backend, implements and verifies them in the workspace, then marks done with notes." },
  { key: "QA",     name: "QA Engineer",          role: "qa",       icon: "bug",        boss: "LEAD", cap: "The quality loop. When a verification issue's blockers are done, exercise the feature end-to-end against the acceptance criteria. PASS -> mark the issue done with a PASS comment (unblocks the parent). FAIL -> do NOT fix it yourself: create a bounce-back child issue assigned to the developer who did the work with failure + repro steps, keep the verification blocked until fixed, then re-verify." },
  { key: "REFA",   name: "Refactoring Engineer", role: "engineer", icon: "wrench",     boss: "LEAD", cap: "After features land, refactors to remove duplication, simplify, and enforce patterns WITHOUT changing behavior. Verifies tests still pass, marks done with notes." },
  { key: "DEVOPS", name: "DevOps Engineer",      role: "devops",   icon: "git-branch", boss: "CTO",  cap: "Owns CI/CD, builds, deployments, environments, containers. Performs assigned ops tasks, verifies the result, marks done with notes." },
  { key: "SEC",    name: "Security Engineer",    role: "security", icon: "shield",     boss: "CTO",  cap: "Reviews changes for security issues, dependency/secret hygiene, and hardening. Files issues for problems and verifies fixes." },
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
