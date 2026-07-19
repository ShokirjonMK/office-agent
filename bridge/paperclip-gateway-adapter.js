"use strict";

// ─────────────────────────────────────────────────────────────
// Claw3D ↔ Paperclip bridge gateway adapter
//
// Speaks the same WebSocket "gateway" protocol (protocol 3) that
// demo-gateway-adapter.js implements, but sources the agent roster
// LIVE from a running Paperclip server's REST API. This lets the
// Claw3D 3D office render Paperclip's real agents as office workers.
//
// Run:  node server/paperclip-gateway-adapter.js
// Env:
//   DEMO_ADAPTER_PORT      port to listen on (default 18789 — same as demo,
//                          so existing Claw3D "demo" profile just works)
//   PAPERCLIP_API          Paperclip API base (default http://127.0.0.1:3100/api)
//   PAPERCLIP_COMPANY      company UUID or issue-prefix (default: first company)
//   PAPERCLIP_POLL_MS      roster refresh interval (default 5000)
// ─────────────────────────────────────────────────────────────

const http = require("http");
const { randomUUID } = require("crypto");
const { WebSocketServer } = require("ws");

const ADAPTER_PORT = parseInt(process.env.DEMO_ADAPTER_PORT || "18789", 10);
const API_BASE = (process.env.PAPERCLIP_API || "http://127.0.0.1:3100/api").replace(/\/$/, "");
const COMPANY_HINT = process.env.COMPANY || process.env.PAPERCLIP_COMPANY || "";
const POLL_MS = parseInt(process.env.PAPERCLIP_POLL_MS || "5000", 10);
const MAIN_KEY = "main";
const MODELS = [{ id: "paperclip/claude", name: "Claude (Paperclip)", provider: "paperclip" }];

// icon (paperclip) → emoji (office avatar hint)
const ICON_EMOJI = {
  eye: "👁️",
  sparkles: "✨",
  robot: "🤖",
  brain: "🧠",
  code: "💻",
  rocket: "🚀",
  briefcase: "💼",
  crown: "👑",
  wrench: "🔧",
  chart: "📊",
};

let COMPANY = null; // {id, name, issuePrefix}
const agents = new Map(); // id -> {id, name, role, workspace, emoji, status, title}
const sessionSettings = new Map();
const conversationHistory = new Map();
const activeRuns = new Map();
const activeSendEventFns = new Set();

function randomId() {
  return randomUUID().replace(/-/g, "");
}
function sessionKeyFor(agentId) {
  return `agent:${agentId}:${MAIN_KEY}`;
}
function getHistory(sessionKey) {
  if (!conversationHistory.has(sessionKey)) conversationHistory.set(sessionKey, []);
  return conversationHistory.get(sessionKey);
}
function clearHistory(sessionKey) {
  conversationHistory.delete(sessionKey);
}
function resOk(id, payload) {
  return { type: "res", id, ok: true, payload: payload ?? {} };
}
function resErr(id, code, message) {
  return { type: "res", id, ok: false, error: { code, message } };
}
function broadcastEvent(frame) {
  for (const send of activeSendEventFns) {
    try {
      send(frame);
    } catch {}
  }
}

async function apiGet(path) {
  const r = await fetch(`${API_BASE}${path}`, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`GET ${path} -> ${r.status}`);
  return r.json();
}

async function apiPost(path, body) {
  const r = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const text = await r.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  if (!r.ok) throw new Error(`POST ${path} -> ${r.status}: ${text.slice(0, 200)}`);
  return json;
}

// Office chat → real Paperclip work: create an issue assigned to the agent,
// then trigger its heartbeat so it starts working immediately.
async function createPaperclipTask(agent, message) {
  const title = message.replace(/\s+/g, " ").trim().slice(0, 120) || "Task from Claw3D office";
  const issue = await apiPost(`/companies/${COMPANY.id}/issues`, {
    title,
    description: message,
    priority: "medium",
    assigneeAgentId: agent.id,
    responsibleUserId: "local-board",
  });
  const ref = issue?.reference || issue?.key || issue?.id || "(new task)";
  // Kick the agent so it picks the task up now instead of waiting for a heartbeat.
  let triggered = false;
  try {
    await apiPost(`/agents/${agent.id}/heartbeat/invoke`, {});
    triggered = true;
  } catch {}
  return { ref, triggered };
}

async function resolveCompany() {
  const companies = await apiGet("/companies");
  if (!Array.isArray(companies) || companies.length === 0) throw new Error("no companies found in Paperclip");
  let picked = null;
  if (COMPANY_HINT) {
    picked = companies.find(
      (c) => c.id === COMPANY_HINT || c.issuePrefix === COMPANY_HINT || c.name === COMPANY_HINT
    );
  }
  picked = picked || companies[0];
  COMPANY = { id: picked.id, name: picked.name, issuePrefix: picked.issuePrefix };
  return COMPANY;
}

function defaultAgentId() {
  // prefer an active, top-of-chain (reportsTo === null) agent; else first.
  const list = [...agents.values()];
  const lead = list.find((a) => a.status === "active" && a.reportsTo == null);
  return (lead || list[0])?.id || null;
}

async function refreshAgents() {
  if (!COMPANY) await resolveCompany();
  const list = await apiGet(`/companies/${COMPANY.id}/agents`);
  if (!Array.isArray(list)) return;
  const seenIds = new Set();
  let changed = false;
  for (const a of list) {
    seenIds.add(a.id);
    const mapped = {
      id: a.id,
      name: a.name,
      title: a.title || a.role || "",
      role: a.title || a.role || "Agent",
      status: a.status || "unknown",
      reportsTo: a.reportsTo ?? null,
      emoji: ICON_EMOJI[a.icon] || "🤖",
      workspace: `/paperclip/${COMPANY.issuePrefix || "co"}/${a.urlKey || a.id}`,
    };
    const prev = agents.get(a.id);
    if (!prev || prev.name !== mapped.name || prev.status !== mapped.status || prev.role !== mapped.role) {
      changed = true;
    }
    agents.set(a.id, mapped);
  }
  for (const id of [...agents.keys()]) {
    if (!seenIds.has(id)) {
      agents.delete(id);
      changed = true;
    }
  }
  if (changed) {
    broadcastEvent({
      type: "event",
      event: "presence",
      payload: { sessions: { recent: [], byAgent: [] } },
    });
  }
}

function agentListPayload() {
  return [...agents.values()].map((agent) => ({
    id: agent.id,
    name: agent.name,
    workspace: agent.workspace,
    identity: { name: agent.name, emoji: agent.emoji },
    role: agent.role,
  }));
}

function buildReply(agent, message) {
  const status = agent.status === "active" ? "active and on duty" : `currently ${agent.status}`;
  const focus = message.replace(/\s+/g, " ").trim().slice(0, 160);
  return (
    `${agent.name} (${agent.title || agent.role}) — ${status} in the ${COMPANY?.name || "company"} office.\n\n` +
    `You said: "${focus}".\n\n` +
    `I'm a Paperclip-managed agent surfaced into the Claw3D office. To make me actually work this, ` +
    `open the Paperclip dashboard and assign it as a task — heartbeat execution will pick it up under my org chain.`
  );
}

async function handleMethod(method, params, id, sendEvent) {
  const p = params || {};
  switch (method) {
    case "agents.list":
      return resOk(id, { defaultId: defaultAgentId(), mainKey: MAIN_KEY, agents: agentListPayload() });

    case "agents.create":
    case "agents.update":
    case "agents.delete":
      // Managed in Paperclip — office is read-only over the roster.
      return resErr(id, "unsupported_method", "Manage agents in the Paperclip dashboard.");

    case "agents.files.get":
      return resOk(id, { file: { missing: true } });
    case "agents.files.set":
      return resOk(id, {});

    case "config.get":
      return resOk(id, {
        config: { gateway: { reload: { mode: "hot" } } },
        hash: "paperclip-gateway",
        exists: true,
        path: "/paperclip/config.json",
      });
    case "config.patch":
    case "config.set":
      return resOk(id, { hash: "paperclip-gateway" });

    case "exec.approvals.get":
      return resOk(id, {
        path: "",
        exists: true,
        hash: "paperclip-approvals",
        file: { version: 1, defaults: { security: "full", ask: "off", autoAllowSkills: true }, agents: {} },
      });
    case "exec.approvals.set":
      return resOk(id, { hash: "paperclip-approvals" });
    case "exec.approval.resolve":
      return resOk(id, { ok: true });

    case "models.list":
      return resOk(id, { models: MODELS });
    case "skills.status":
      return resOk(id, { skills: [] });
    case "cron.list":
      return resOk(id, { jobs: [] });
    case "cron.add":
    case "cron.run":
    case "cron.remove":
      return resErr(id, "unsupported_method", `Paperclip bridge does not support ${method}.`);

    case "sessions.list": {
      const sessions = [...agents.values()].map((agent) => {
        const sessionKey = sessionKeyFor(agent.id);
        const history = getHistory(sessionKey);
        const settings = sessionSettings.get(sessionKey) || {};
        return {
          key: sessionKey,
          agentId: agent.id,
          updatedAt: history.length > 0 ? Date.now() : null,
          displayName: "Main",
          origin: { label: agent.name, provider: "paperclip" },
          model: settings.model || MODELS[0].id,
          modelProvider: "paperclip",
        };
      });
      return resOk(id, { sessions });
    }

    case "sessions.preview": {
      const keys = Array.isArray(p.keys) ? p.keys : [];
      const limit = typeof p.limit === "number" ? p.limit : 8;
      const maxChars = typeof p.maxChars === "number" ? p.maxChars : 240;
      const previews = keys.map((key) => {
        const history = getHistory(key);
        if (history.length === 0) return { key, status: "empty", items: [] };
        const items = history.slice(-limit).map((msg) => ({
          role: msg.role === "assistant" ? "assistant" : "user",
          text: String(msg.content || "").slice(0, maxChars),
          timestamp: Date.now(),
        }));
        return { key, status: "ok", items };
      });
      return resOk(id, { ts: Date.now(), previews });
    }

    case "sessions.patch": {
      const key = typeof p.key === "string" ? p.key : sessionKeyFor(defaultAgentId());
      const current = sessionSettings.get(key) || {};
      const next = { ...current };
      if (p.model !== undefined) next.model = p.model;
      if (p.thinkingLevel !== undefined) next.thinkingLevel = p.thinkingLevel;
      sessionSettings.set(key, next);
      return resOk(id, {
        ok: true,
        key,
        entry: { thinkingLevel: next.thinkingLevel },
        resolved: { model: next.model || MODELS[0].id, modelProvider: "paperclip" },
      });
    }

    case "sessions.reset": {
      const key = typeof p.key === "string" ? p.key : sessionKeyFor(defaultAgentId());
      clearHistory(key);
      return resOk(id, { ok: true });
    }

    case "chat.send": {
      const sessionKey = typeof p.sessionKey === "string" ? p.sessionKey : sessionKeyFor(defaultAgentId());
      const agentId = sessionKey.startsWith("agent:") ? sessionKey.split(":")[1] : defaultAgentId();
      const agent = agents.get(agentId) || [...agents.values()][0];
      const message = typeof p.message === "string" ? p.message.trim() : String(p.message || "").trim();
      const runId = typeof p.idempotencyKey === "string" && p.idempotencyKey ? p.idempotencyKey : randomId();
      if (!message || !agent) return resOk(id, { status: "no-op", runId });

      let aborted = false;
      activeRuns.set(runId, { runId, sessionKey, abort() { aborted = true; } });

      setImmediate(async () => {
        let seq = 0;
        const emitChat = (state, extra) => {
          sendEvent({ type: "event", event: "chat", seq: seq++, payload: { runId, sessionKey, state, ...extra } });
        };
        // Show a working indicator while we create + trigger the real task.
        emitChat("delta", { message: { role: "assistant", content: `${agent.name} is creating a task in Paperclip…` } });
        let reply;
        try {
          const { ref, triggered } = await createPaperclipTask(agent, message);
          reply =
            `✅ Created task **${ref}** and assigned it to **${agent.name}** (${agent.title || agent.role}).\n\n` +
            (triggered
              ? `${agent.name} has been woken and is working on it now — watch the Paperclip dashboard for live progress.`
              : `It's queued; ${agent.name} will pick it up on the next heartbeat.`);
        } catch (err) {
          reply = `⚠️ Couldn't create the task in Paperclip: ${err instanceof Error ? err.message : String(err)}`;
        }
        try {
          if (aborted) {
            emitChat("aborted", {});
            return;
          }
          const words = reply.split(" ");
          let partial = "";
          for (const word of words) {
            if (aborted) break;
            partial = partial ? `${partial} ${word}` : word;
            emitChat("delta", { message: { role: "assistant", content: partial } });
            await new Promise((r) => setTimeout(r, 15));
          }
          if (aborted) {
            emitChat("aborted", {});
            return;
          }
          const history = getHistory(sessionKey);
          history.push({ role: "user", content: message });
          history.push({ role: "assistant", content: reply });
          emitChat("final", { stopReason: "end_turn", message: { role: "assistant", content: reply } });
          sendEvent({
            type: "event",
            event: "presence",
            seq: seq++,
            payload: {
              sessions: {
                recent: [{ key: sessionKey, updatedAt: Date.now() }],
                byAgent: [{ agentId, recent: [{ key: sessionKey, updatedAt: Date.now() }] }],
              },
            },
          });
        } finally {
          activeRuns.delete(runId);
        }
      });

      return resOk(id, { status: "started", runId });
    }

    case "chat.abort": {
      const runId = typeof p.runId === "string" ? p.runId.trim() : "";
      const sessionKey = typeof p.sessionKey === "string" ? p.sessionKey.trim() : "";
      let aborted = 0;
      if (runId) {
        const handle = activeRuns.get(runId);
        if (handle) { handle.abort(); activeRuns.delete(runId); aborted += 1; }
      } else if (sessionKey) {
        for (const [activeRunId, handle] of activeRuns.entries()) {
          if (handle.sessionKey !== sessionKey) continue;
          handle.abort();
          activeRuns.delete(activeRunId);
          aborted += 1;
        }
      }
      return resOk(id, { ok: true, aborted });
    }

    case "chat.history": {
      const sessionKey = typeof p.sessionKey === "string" ? p.sessionKey : sessionKeyFor(defaultAgentId());
      return resOk(id, { sessionKey, messages: getHistory(sessionKey) });
    }

    case "agent.wait": {
      const runId = typeof p.runId === "string" ? p.runId : "";
      const timeoutMs = typeof p.timeoutMs === "number" ? p.timeoutMs : 30000;
      const start = Date.now();
      while (activeRuns.has(runId) && Date.now() - start < timeoutMs) {
        await new Promise((r) => setTimeout(r, 50));
      }
      return resOk(id, { status: activeRuns.has(runId) ? "running" : "done" });
    }

    case "status": {
      const recent = [...agents.keys()].flatMap((agentId) => {
        const key = sessionKeyFor(agentId);
        const history = getHistory(key);
        return history.length > 0 ? [{ key, updatedAt: Date.now() }] : [];
      });
      return resOk(id, {
        sessions: {
          recent,
          byAgent: [...agents.keys()].map((agentId) => ({
            agentId,
            recent: recent.filter((entry) => entry.key.includes(`:${agentId}:`)),
          })),
        },
      });
    }

    case "wake":
      return resOk(id, { ok: true });

    default:
      return resOk(id, {});
  }
}

function connectPayload() {
  return {
    type: "hello-ok",
    protocol: 3,
    adapterType: "openclaw", // present as a real (non-demo) adapter so the office
    // leaves the demo lobby, skips the seeded "main", and hydrates the real roster
    runtimeName: "Paperclip Bridge",
    vendor: "paperclip",
    features: {
      methods: [
        "agents.list", "sessions.list", "sessions.preview", "sessions.patch", "sessions.reset",
        "chat.send", "chat.abort", "chat.history", "agent.wait", "status",
        "config.get", "config.set", "config.patch",
        "agents.files.get", "agents.files.set",
        "exec.approvals.get", "exec.approvals.set", "exec.approval.resolve",
        "wake", "skills.status", "models.list", "cron.list",
      ],
      events: ["chat", "presence", "heartbeat"],
    },
    snapshot: {
      health: {
        agents: [...agents.values()].map((agent) => ({
          agentId: agent.id,
          name: agent.name,
          isDefault: agent.id === defaultAgentId(),
        })),
        defaultAgentId: defaultAgentId(),
      },
      sessionDefaults: { mainKey: MAIN_KEY },
    },
    auth: { role: "operator", scopes: ["operator.admin"] },
    policy: { tickIntervalMs: 30000 },
  };
}

function startAdapter() {
  const httpServer = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Claw3D ↔ Paperclip Bridge Gateway Adapter\n");
  });

  const wss = new WebSocketServer({ server: httpServer });
  wss.on("connection", (ws) => {
    let connected = false;
    let globalSeq = 0;
    const send = (frame) => {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(JSON.stringify(frame));
    };
    const sendEventFn = (frame) => {
      if (frame.type === "event" && typeof frame.seq !== "number") frame.seq = globalSeq++;
      send(frame);
    };
    activeSendEventFns.add(sendEventFn);
    send({ type: "event", event: "connect.challenge", payload: { nonce: randomId() } });

    ws.on("message", async (raw) => {
      let frame;
      try {
        frame = JSON.parse(raw.toString("utf8"));
      } catch {
        return;
      }
      if (!frame || typeof frame !== "object" || frame.type !== "req") return;
      const { id, method, params } = frame;
      if (typeof id !== "string" || typeof method !== "string") return;

      if (method === "connect") {
        connected = true;
        try {
          await refreshAgents();
        } catch (e) {
          console.error("[paperclip-gateway] refresh on connect failed:", e.message);
        }
        send({ type: "res", id, ok: true, payload: connectPayload() });
        return;
      }
      if (!connected) {
        send(resErr(id, "not_connected", "Send connect first."));
        return;
      }
      try {
        send(await handleMethod(method, params, id, sendEventFn));
      } catch (error) {
        send(resErr(id, "internal_error", error instanceof Error ? error.message : "Internal error"));
      }
    });

    ws.on("close", () => activeSendEventFns.delete(sendEventFn));
    ws.on("error", () => activeSendEventFns.delete(sendEventFn));
  });

  httpServer.listen(ADAPTER_PORT, "127.0.0.1", async () => {
    console.log(`[paperclip-gateway] Listening on ws://localhost:${ADAPTER_PORT}`);
    try {
      await resolveCompany();
      await refreshAgents();
      console.log(`[paperclip-gateway] Company: ${COMPANY.name} (${COMPANY.id}) — ${agents.size} agent(s):`);
      for (const a of agents.values()) console.log(`  ${a.emoji} ${a.name} — ${a.role} [${a.status}]`);
    } catch (e) {
      console.error("[paperclip-gateway] initial load failed:", e.message);
      console.error("  Is Paperclip running at " + API_BASE + " ?");
    }
    setInterval(() => {
      refreshAgents().catch((e) => console.error("[paperclip-gateway] poll failed:", e.message));
    }, POLL_MS);
  });
}

if (require.main === module) startAdapter();

module.exports = { handleMethod, startAdapter };
