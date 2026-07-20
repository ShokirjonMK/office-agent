#!/usr/bin/env node
// Telegram -> firm bridge: control the Paperclip agent firm from Telegram.
// Zero-dependency (plain fetch long-polling). Any message becomes a real task
// assigned to the Product Manager, who delegates it down the org chart.
//
// Env:
//   TELEGRAM_BOT_TOKEN   (required) from @BotFather
//   TELEGRAM_OWNER_ID    (required) your Telegram numeric user id (@userinfobot)
//   PAPERCLIP_API        default http://127.0.0.1:3100/api
//   COMPANY              company UUID / prefix / name (default: first)
//
// Commands:  /task <text> | (plain text) -> new task for the PM
//            /agents  -> roster + status      /tasks -> recent issues
//            /whoami  -> your id              /help

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OWNER = String(process.env.TELEGRAM_OWNER_ID || "").trim();
const API = (process.env.PAPERCLIP_API || "http://127.0.0.1:3100/api").replace(/\/$/, "");
const COMPANY_HINT = process.env.COMPANY || process.env.PAPERCLIP_COMPANY || "";
const TG = `https://api.telegram.org/bot${TOKEN}`;

if (!TOKEN || !OWNER) {
  console.error("[tg] TELEGRAM_BOT_TOKEN and TELEGRAM_OWNER_ID are required.");
  process.exit(1);
}

async function pcGet(p) {
  const r = await fetch(`${API}${p}`, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`GET ${p} -> ${r.status}`);
  return r.json();
}
async function pcPost(p, body) {
  const r = await fetch(`${API}${p}`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`POST ${p} -> ${r.status}: ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
}
async function tg(method, payload) {
  const r = await fetch(`${TG}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return r.json();
}
const send = (text) => tg("sendMessage", { chat_id: OWNER, text, parse_mode: "Markdown" }).catch(() => {});

let COMPANY = null;
async function company() {
  if (COMPANY) return COMPANY;
  const cs = await pcGet("/companies");
  COMPANY =
    (COMPANY_HINT && cs.find((c) => c.id === COMPANY_HINT || c.issuePrefix === COMPANY_HINT || c.name === COMPANY_HINT)) ||
    cs[0];
  return COMPANY;
}
async function agents() {
  const c = await company();
  return pcGet(`/companies/${c.id}/agents`);
}
async function pmId() {
  const a = await agents();
  const pm = a.find((x) => x.role === "pm") || a.find((x) => x.role === "ceo") || a[0];
  return pm?.id;
}

let ACTIVE_PROJECT = null; // { id, name } — which project new tasks target

async function projects() {
  const c = await company();
  const raw = await pcGet(`/companies/${c.id}/projects`).catch(() => []);
  return Array.isArray(raw) ? raw : raw.projects ?? [];
}

async function createTask(text) {
  const c = await company();
  const assignee = await pmId();
  const title = text.replace(/\s+/g, " ").trim().slice(0, 120);
  const issue = await pcPost(`/companies/${c.id}/issues`, {
    title,
    description: text,
    assigneeAgentId: assignee,
    responsibleUserId: "local-board",
    ...(ACTIVE_PROJECT ? { projectId: ACTIVE_PROJECT.id } : {}),
  });
  await pcPost(`/agents/${assignee}/heartbeat/invoke`, {}).catch(() => {});
  return issue?.reference || issue?.id || "(new task)";
}

const TERMINAL = new Set(["done", "closed", "cancelled", "canceled", "archived"]);
async function handle(text) {
  const [cmd, ...rest] = text.trim().split(/\s+/);
  const arg = text.trim().replace(/^\/\S+\s*/, "");
  if (cmd === "/start" || cmd === "/help") {
    return send(
      "*Firm control*\nSend any message → a task for the Product Manager (delegates down the org chart).\n\n" +
        "*Tasks*\n`/task <text>` new task\n`/tasks` recent issues\n`/agents` roster + status\n\n" +
        "*Projects*\n`/projects` list projects\n`/use <name>` pick the active project (new tasks target it)\n`/newproject <name> | <repoUrl>` create a git-backed project\n\n" +
        "`/whoami` your id",
    );
  }
  if (cmd === "/whoami") return send(`Your id: \`${OWNER}\``);
  if (cmd === "/projects") {
    const ps = await projects();
    if (!ps.length) return send("No projects yet. Create one with `/newproject <name> | <repoUrl>` or in the dashboard.");
    const lines = ps.map((p) => `${ACTIVE_PROJECT?.id === p.id ? "▶︎" : "•"} ${p.name}${p.codebase?.repoUrl ? ` — \`${p.codebase.repoUrl}\`` : ""}`).join("\n");
    return send(`*Projects* (▶︎ = active)\n${lines}\n\nPick one with \`/use <name>\`.`);
  }
  if (cmd === "/use") {
    const q = arg.trim().toLowerCase();
    if (!q) return send("Usage: `/use <project name>`");
    const ps = await projects();
    const p = ps.find((x) => x.name.toLowerCase() === q || x.id.startsWith(q) || x.urlKey === q);
    if (!p) return send(`No project matches "${arg}". See /projects.`);
    ACTIVE_PROJECT = { id: p.id, name: p.name };
    return send(`▶︎ Active project: *${p.name}*. New tasks will target it.`);
  }
  if (cmd === "/newproject") {
    const [name, repoUrl] = arg.split("|").map((s) => s.trim());
    if (!name) return send("Usage: `/newproject <name> | <repoUrl>`  (repoUrl optional)");
    const c = await company();
    try {
      const p = await pcPost(`/companies/${c.id}/projects`, {
        name,
        ...(repoUrl ? { workspace: { name: "main", sourceType: "git_repo", repoUrl, repoRef: "main" } } : {}),
      });
      ACTIVE_PROJECT = { id: p.id, name: p.name };
      return send(`✅ Project *${p.name}* created${repoUrl ? ` (repo \`${repoUrl}\`)` : ""} and set active.`);
    } catch (e) {
      return send(`⚠️ Couldn't create the project: ${e.message}`);
    }
  }
  if (cmd === "/agents") {
    const a = await agents();
    const by = {};
    a.forEach((x) => (by[x.status] = (by[x.status] || 0) + 1));
    const lines = a.slice(0, 20).map((x) => `• ${x.name} — _${x.status}_`).join("\n");
    return send(`*${a.length} agents* (${Object.entries(by).map(([k, v]) => `${v} ${k}`).join(", ")})\n${lines}`);
  }
  if (cmd === "/tasks") {
    const c = await company();
    const raw = await pcGet(`/companies/${c.id}/issues`).catch(() => []);
    const arr = Array.isArray(raw) ? raw : raw.issues ?? [];
    const open = arr.filter((i) => !TERMINAL.has(String(i.status).toLowerCase())).slice(0, 12);
    if (!open.length) return send("No open tasks.");
    return send("*Open tasks:*\n" + open.map((i) => `• ${i.reference || i.id.slice(0, 6)} _${i.status}_ — ${i.title}`).join("\n"));
  }
  const body = cmd === "/task" ? arg : text.trim();
  if (!body) return send("Send a task description, or /help.");
  try {
    const ref = await createTask(body);
    const where = ACTIVE_PROJECT ? ` in project *${ACTIVE_PROJECT.name}*` : "";
    return send(`✅ Task *${ref}* created${where} and assigned to the Product Manager. It will delegate it down the team — check /tasks for progress.`);
  } catch (e) {
    return send(`⚠️ Couldn't create the task: ${e.message}`);
  }
}

async function main() {
  const me = await tg("getMe").catch(() => null);
  console.log(`[tg] firm bot online as @${me?.result?.username || "?"} — owner ${OWNER}, api ${API}`);
  await send("🏢 Firm control bot online. Send a task or /help.");
  let offset = 0;
  // long-poll loop
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let updates;
    try {
      const r = await fetch(`${TG}/getUpdates?timeout=50&offset=${offset}`, { signal: AbortSignal.timeout(60000) });
      updates = (await r.json())?.result || [];
    } catch {
      await new Promise((s) => setTimeout(s, 2000));
      continue;
    }
    for (const u of updates) {
      offset = u.update_id + 1;
      const msg = u.message || u.edited_message;
      if (!msg || !msg.text) continue;
      if (String(msg.from?.id) !== OWNER) {
        await tg("sendMessage", { chat_id: msg.chat.id, text: "Not authorized." }).catch(() => {});
        continue;
      }
      await handle(msg.text).catch((e) => send(`error: ${e.message}`));
    }
  }
}

main().catch((e) => { console.error("[tg] fatal:", e.message); process.exit(1); });
