/**
 * zCode → Kaiban live bridge.
 *
 * Serves ~/.zcode/ agent/task state as a Kanban board feed.
 * STRICTLY READ-ONLY: this server never writes inside ~/.zcode/.
 *
 * Discovered real state format (2026-09-07):
 *  - ~/.zcode/cli/agents/sess_<id>/agent_<id>/metadata.json  ← PRIMARY task state.
 *    Fields: agentId, description (task title), prompt, status ("completed" |
 *    "failed" | "running"), profileSnapshot{name, description} (the agent
 *    profile that ran), createdAt/updatedAt/completedAt, totalTokens,
 *    totalDurationMs, cwd, parentSessionId.
 *  - ~/.zcode/v2/bot-config.json + bot-state.v2.json    ← telegram bots that
 *    drive zCode sessions (name, enabled, mode, activeTaskId, updatedAt).
 *  - ~/.zcode/agents/  (empty on this machine) and ~/.zcode/workspace/ (one
 *    project dir each) are parsed per the original spec, with folder-heuristic
 *    status inference as fallback.
 *  - ~/.zcode/v2/tasks-index.sqlite and cli/db/db.sqlite exist but are skipped
 *    on purpose: opening SQLite (WAL mode) read-only can still touch the
 *    -shm/-wal sidecar files, which would violate the read-only constraint.
 */
import { watch, type FSWatcher } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { homedir } from "node:os";

const ZCODE_DIR = process.env.ZCODE_DIR ?? join(homedir(), ".zcode");
const PORT = Number(process.env.PORT ?? 4310);
const DEBOUNCE_MS = 500;
const POLL_FALLBACK_MS = 5000;
const RECENT_MS = 5 * 60 * 1000; // "touched recently" window for DOING heuristic
const MAX_AGENT_RUN_TASKS = 60; // cap so the board stays usable (most recent first)

type KStatus = "TODO" | "DOING" | "BLOCKED" | "DONE";

interface KAgent {
  id: string;
  name: string;
  role: string;
  goal: string;
  background: string;
}

interface KTask {
  id: string;
  title: string;
  description: string;
  status: KStatus;
  agent: string;
}

interface KTeam {
  name: string;
  agents: KAgent[];
  tasks: KTask[];
}

/* ------------------------------------------------------------------ utils */

async function safeReadJson(file: string): Promise<any | null> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return []; // missing/unreadable folder → treated as empty (graceful)
  }
}

async function dirExists(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * HEURISTIC (spec): map arbitrary status keywords onto the 4 kanban columns.
 * Real observed values in metadata.json today: "completed", "failed";
 * "running" is expected while an agent is live.
 */
function normalizeStatus(s: string): KStatus {
  const v = s.toLowerCase();
  if (/(doing|running|progress|active|in_progress|working)/.test(v)) return "DOING";
  if (/(done|complete|finish|succe)/.test(v)) return "DONE";
  if (/(block|error|fail|crash|cancel|abort)/.test(v)) return "BLOCKED";
  return "TODO";
}

/**
 * HEURISTIC (spec): status guess for a directory with no explicit status
 * field — crash/error markers → BLOCKED, anything modified < 5 min → DOING,
 * otherwise DONE.
 */
async function inferStatus(dir: string): Promise<KStatus> {
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return "TODO";
  }
  if (names.some((n) => /(error|failed|crash)/i.test(n))) return "BLOCKED";
  const now = Date.now();
  for (const n of names) {
    try {
      const st = await stat(join(dir, n));
      if (st.isFile() && now - st.mtimeMs < RECENT_MS) return "DOING";
    } catch {
      /* file vanished mid-scan — ignore */
    }
  }
  return "DONE";
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/* ------------------------------------------------- source: cli/agent runs */

/**
 * Primary source. Every ~/.zcode/cli/agents/sess_<id>/agent_<id>/metadata.json
 * is one dispatched agent run → one task card. Agents are the distinct
 * profileSnapshot profiles used across runs (Explore, general-purpose, ...).
 */
async function collectAgentRuns(): Promise<{ agents: KAgent[]; tasks: KTask[] }> {
  const agentsDir = join(ZCODE_DIR, "cli", "agents");
  const profiles = new Map<string, KAgent>();
  const runs: Array<{ meta: any; dir: string }> = [];

  for (const sess of await safeReaddir(agentsDir)) {
    for (const agentDir of await safeReaddir(join(agentsDir, sess))) {
      const dir = join(agentsDir, sess, agentDir);
      const meta = await safeReadJson(join(dir, "metadata.json"));
      if (!meta || typeof meta !== "object") continue; // incomplete run — skip

      const profile = meta.profileSnapshot ?? {};
      const name = String(profile.name ?? meta.profileId ?? "zCode");
      if (!profiles.has(name)) {
        profiles.set(name, {
          id: `profile:${name}`,
          name,
          role: String(profile.name ?? name),
          goal: `Handle ${name} work dispatched by zCode`,
          background: truncate(String(profile.description ?? "zCode built-in agent profile"), 300),
        });
      }
      runs.push({ meta, dir });
    }
  }

  // Newest runs first, capped — old history stays in ~/.zcode, not on the board.
  runs.sort((a, b) => {
    const ta = Date.parse(String(a.meta.createdAt ?? "")) || 0;
    const tb = Date.parse(String(b.meta.createdAt ?? "")) || 0;
    return tb - ta;
  });

  const tasks: KTask[] = [];
  for (const { meta, dir } of runs.slice(0, MAX_AGENT_RUN_TASKS)) {
    const profile = meta.profileSnapshot ?? {};
    const name = String(profile.name ?? meta.profileId ?? "zCode");
    // Real status field when present; otherwise folder-heuristic fallback
    // (a live run with no status yet has a fresh transcript.jsonl → DOING).
    const status = meta.status
      ? normalizeStatus(String(meta.status))
      : await inferStatus(dir);

    const facts = [
      meta.cwd ? `workspace: ${meta.cwd}` : null,
      meta.totalTokens ? `${Number(meta.totalTokens).toLocaleString()} tokens` : null,
      meta.totalDurationMs ? `${Math.round(Number(meta.totalDurationMs) / 1000)}s` : null,
      meta.parentSessionId ? `session: ${meta.parentSessionId}` : null,
    ].filter(Boolean);

    tasks.push({
      id: `run:${String(meta.agentId ?? dir)}`,
      title: truncate(String(meta.description ?? "Untitled agent run"), 120),
      description: [truncate(String(meta.prompt ?? "").trim(), 400), facts.join(" · ")]
        .filter(Boolean)
        .join("\n\n") || "No description recorded.",
      status,
      agent: name,
    });
  }

  return { agents: [...profiles.values()], tasks };
}

/* ------------------------------------------------- source: v2 bots (real) */

/**
 * Discovered format: ~/.zcode/v2/bot-config.json (bot definitions) joined with
 * bot-state.v2.json (runtime state). Each bot becomes an agent; each bot in
 * task mode also gets one card reflecting its liveness (recent updatedAt →
 * DOING, stale but enabled → TODO, disabled → BLOCKED would be wrong, so TODO
 * with a note — see status map below).
 */
async function collectBots(): Promise<{ agents: KAgent[]; tasks: KTask[] }> {
  const cfg = await safeReadJson(join(ZCODE_DIR, "v2", "bot-config.json"));
  const state = await safeReadJson(join(ZCODE_DIR, "v2", "bot-state.v2.json"));
  if (!cfg?.bots || !Array.isArray(cfg.bots)) return { agents: [], tasks: [] };

  const agents: KAgent[] = [];
  const tasks: KTask[] = [];
  for (const bot of cfg.bots) {
    const name = String(bot.name ?? bot.id ?? "bot");
    const st = state?.bots?.[bot.id] ?? {};
    const updatedAt = Number(st.updatedAt ?? 0);
    const fresh = updatedAt > 0 && Date.now() - updatedAt < RECENT_MS;

    agents.push({
      id: `bot:${bot.id ?? name}`,
      name,
      role: `${String(bot.provider ?? "messaging")} bot`,
      goal: `Supervise zCode task-mode sessions (${st.mode ?? "task"})`,
      background: truncate(
        `workspace: ${st.workspacePath ?? "?"} · activeTask: ${st.activeTaskId ?? "none"} · ${bot.enabled ? "enabled" : "disabled"}`,
        300,
      ),
    });

    if (st.mode === "task" || st.activeTaskId) {
      // HEURISTIC: bot cards mirror runtime liveness, not workflow state.
      const status: KStatus = !bot.enabled ? "TODO" : fresh ? "DOING" : "TODO";
      tasks.push({
        id: `bot:${String(bot.id ?? name)}`,
        title: `${name} bot — ${st.activeTaskId ? "session active" : "idle"}`,
        description: `provider: ${bot.provider ?? "?"} · workspace: ${st.workspacePath ?? "?"} · activeTaskId: ${st.activeTaskId ?? "-"} · last seen ${updatedAt ? new Date(updatedAt).toISOString() : "never"}${bot.enabled ? "" : " (disabled)"}`,
        status,
        agent: name,
      });
    }
  }
  return { agents, tasks };
}

/* ------------------------------------- source: workspace/ + generic v2 scan */

/**
 * Spec source: one project dir under ~/.zcode/workspace/ = one task, status
 * via folder heuristic (no explicit status exists for these).
 */
async function collectWorkspaceTasks(): Promise<KTask[]> {
  const wsDir = join(ZCODE_DIR, "workspace");
  const tasks: KTask[] = [];
  for (const proj of await safeReaddir(wsDir)) {
    const dir = join(wsDir, proj);
    tasks.push({
      id: `ws:${proj}`,
      title: `Workspace: ${proj}`,
      description: `zCode workspace project directory (~/.zcode/workspace/${proj}).`,
      status: await inferStatus(dir),
      agent: "zCode",
    });
  }
  return tasks;
}

/**
 * Spec source: task-like JSON under ~/.zcode/v2/ (recursive, depth ≤ 3) whose
 * TOP-LEVEL fields include title/name/description. Kept generic so future
 * zCode state files show up without code changes.
 */
async function collectV2TaskLikeFiles(): Promise<KTask[]> {
  const v2Dir = join(ZCODE_DIR, "v2");

  async function walk(dir: string, depth: number, out: string[]): Promise<void> {
    if (depth > 3) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!e.name.startsWith(".")) await walk(full, depth + 1, out);
      } else if (e.isFile() && e.name.endsWith(".json") && !e.name.startsWith(".")) {
        out.push(full);
      }
    }
  }

  const files: string[] = [];
  await walk(v2Dir, 1, files);

  const tasks: KTask[] = [];
  for (const file of files) {
    const data = await safeReadJson(file);
    if (!data || typeof data !== "object") continue;
    // HEURISTIC: a "task-like" file exposes one of these top-level fields.
    const title = data.title ?? data.name;
    if (typeof title !== "string" || !title) continue;

    const rel = relative(v2Dir, file);
    let st: any = null;
    try {
      st = await stat(file);
    } catch {
      /* ignore */
    }
    const status: KStatus = data.status
      ? normalizeStatus(String(data.status))
      : st && Date.now() - st.mtimeMs < RECENT_MS
        ? "DOING" // HEURISTIC: recently modified state file → active
        : "DONE";

    tasks.push({
      id: `v2:${rel}`,
      title: truncate(title, 120),
      description: truncate(String(data.description ?? "(no description)"), 400),
      status,
      agent: "zCode",
    });
  }
  return tasks;
}

/* -------------------------------------------------------- spec: agents dir */

/**
 * Spec source: ~/.zcode/agents/ (empty on this machine). Parse agent JSON if
 * present, else fall back to folder/file names.
 */
async function collectAgentsDir(): Promise<KAgent[]> {
  const dir = join(ZCODE_DIR, "agents");
  const out: KAgent[] = [];
  for (const name of await safeReaddir(dir)) {
    const meta = await safeReadJson(join(dir, name, "agent.json"))
      ?? (await safeReadJson(join(dir, `${name}.json`)));
    out.push({
      id: `agents:${name}`,
      name: String(meta?.name ?? name),
      role: String(meta?.role ?? "zCode agent"),
      goal: String(meta?.goal ?? "Assist with zCode tasks"),
      background: truncate(String(meta?.background ?? "agent from ~/.zcode/agents/"), 300),
    });
  }
  // Also tolerate loose *.json files directly in agents/
  try {
    for (const f of await readdir(dir)) {
      if (!f.endsWith(".json")) continue;
      const meta = await safeReadJson(join(dir, f));
      if (meta?.name) {
        out.push({
          id: `agents:${f}`,
          name: String(meta.name),
          role: String(meta.role ?? "zCode agent"),
          goal: String(meta.goal ?? "Assist with zCode tasks"),
          background: truncate(String(meta.background ?? ""), 300),
        });
      }
    }
  } catch {
    /* dir missing — fine */
  }
  return out;
}

/* ------------------------------------------------------------- buildTeams */

const FALLBACK_AGENT: KAgent = {
  id: "zcode",
  name: "zCode",
  role: "Local coding agent",
  goal: "Default owner for tasks with no known agent",
  background: "Fallback agent used when no agent state is found in ~/.zcode/.",
};

async function buildTeams(): Promise<KTeam[]> {
  const [runs, bots, wsTasks, v2Tasks, agentsDir] = await Promise.all([
    collectAgentRuns(),
    collectBots(),
    collectWorkspaceTasks(),
    collectV2TaskLikeFiles(),
    collectAgentsDir(),
  ]);

  // Dedupe agents by name; FALLBACK_AGENT first so orphan tasks have an owner.
  const byName = new Map<string, KAgent>([[FALLBACK_AGENT.name, FALLBACK_AGENT]]);
  for (const a of [...runs.agents, ...bots.agents, ...agentsDir]) {
    if (!byName.has(a.name)) byName.set(a.name, a);
  }

  const tasks = [...runs.tasks, ...bots.tasks, ...wsTasks, ...v2Tasks].map((t) => ({
    ...t,
    agent: byName.has(t.agent) ? t.agent : FALLBACK_AGENT.name,
  }));

  return [{ name: "zCode Workspace", agents: [...byName.values()], tasks }];
}

/* ------------------------------------------------------- SSE hub + watcher */

let watchMode: "watch" | "poll" = "watch";
const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
let lastSnapshot = "";
let heartbeat: ReturnType<typeof setInterval> | null = null;

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function snapshotEvent(): Promise<string> {
  const teams = await buildTeams();
  lastSnapshot = JSON.stringify(teams);
  return sseEvent("snapshot", teams);
}

/** Rebuild state and push to all SSE clients (skipped if nothing changed). */
async function broadcast(): Promise<void> {
  try {
    const teams = await buildTeams();
    const json = JSON.stringify(teams);
    if (json === lastSnapshot) return; // dotfile/tmp churn with no state change
    lastSnapshot = json;
    const frame = sseEvent("snapshot", teams);
    for (const c of clients) {
      try {
        c.enqueue(new TextEncoder().encode(frame));
      } catch {
        clients.delete(c); // dead connection
      }
    }
  } catch (err) {
    console.error("broadcast failed:", err);
  }
}

/** HEURISTIC: churn under tmp/ and dotfiles (.DS_Store, .git, …) is noise. */
function isNoise(rel: string): boolean {
  return rel.split("/").some((seg) => seg === "tmp" || seg.startsWith("."));
}

function startWatcher(): void {
  let timer: ReturnType<typeof setTimeout> | null = null;

  try {
    const watcher: FSWatcher = watch(
      ZCODE_DIR,
      { recursive: true },
      (_event, filename) => {
        const rel = String(filename ?? "");
        if (isNoise(rel)) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          console.log(`📝 changed: ${rel}`);
          void broadcast();
        }, DEBOUNCE_MS);
      },
    );
    watcher.on("error", (err) => {
      console.warn(`⚠️ watcher error: ${err.message} — switching to polling`);
      watcher.close();
      startPolling();
    });
    watchMode = "watch";
    console.log(`👀 watching ${ZCODE_DIR} (fs.watch recursive)`);
  } catch (err) {
    console.warn(
      `⚠️ fs.watch unavailable (${(err as Error).message}) — polling every ${POLL_FALLBACK_MS / 1000}s`,
    );
    startPolling();
  }
}

function startPolling(): void {
  if (watchMode === "poll") return; // already polling
  watchMode = "poll";
  setInterval(() => void broadcast(), POLL_FALLBACK_MS);
}

/* -------------------------------------------------------------- HTTP (Bun) */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Cache-Control": "no-store",
};

Bun.serve({
  port: PORT,
  // SSE connections are long-lived and mostly idle; Bun's default 10s
  // idleTimeout would reap them before the 15s keepalive fires.
  idleTimeout: 0,
  async fetch(req): Promise<Response> {
    const { pathname } = new URL(req.url);

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (pathname === "/api/teams") {
      const teams = await buildTeams();
      lastSnapshot = JSON.stringify(teams);
      return Response.json(teams, { headers: { ...CORS, "X-Watch-Mode": watchMode } });
    }

    if (pathname === "/api/events") {
      const encoder = new TextEncoder();
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({
        async start(c) {
          controller = c;
          clients.add(controller);
          // Spec: initial snapshot immediately, plus hello so the UI can show
          // whether we're on live watching (green) or polling fallback (yellow).
          controller.enqueue(encoder.encode(sseEvent("hello", { mode: watchMode })));
          controller.enqueue(encoder.encode(await snapshotEvent()));
          // Keepalive comments prevent proxies/browsers from idling us out.
          heartbeat = setInterval(() => {
            try {
              controller.enqueue(encoder.encode(": keepalive\n\n"));
            } catch {
              /* dropped */
            }
          }, 15000);
        },
        cancel() {
          if (heartbeat) clearInterval(heartbeat);
          clients.delete(controller);
        },
      });

      return new Response(stream, {
        headers: {
          ...CORS,
          "Content-Type": "text/event-stream",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        },
      });
    }

    return new Response("Not found", { status: 404, headers: CORS });
  },
});

console.log(`🚀 zCode → Kaiban bridge on http://localhost:${PORT} (serving ${ZCODE_DIR} read-only)`);
startWatcher();
