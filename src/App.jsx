import React, { useEffect, useMemo, useRef, useState } from "react";
import KaibanBoard from "kaiban-board";
// CSS path verified against the installed 0.4.4 package: dist/index.css
// (package.json has no "exports" restriction, so the deep import works).
import "kaiban-board/dist/index.css";
// kaiban-board's `teams` prop wants real kaibanjs instances, not plain JSON.
import { Agent, Task, Team } from "kaibanjs";

/**
 * Convert the server's plain-JSON teams into kaibanjs Team instances.
 * Note: Task's constructor has no `status` param, so statuses (plain strings
 * matching TASK_STATUS_enum: TODO | DOING | BLOCKED | DONE) are assigned after
 * construction.
 */
function toKaibanTeams(json) {
  return (json ?? []).map((t) => {
    const agents = t.agents.map(
      (a) =>
        new Agent({
          name: a.name,
          role: a.role,
          goal: a.goal,
          background: a.background,
          // kaibanjs refuses to construct an Agent without an API key unless an
          // apiBaseUrl is set. This bridge is read-only: the LLM is never called,
          // so a placeholder base URL (port 9 = discard) satisfies validation.
          llmConfig: {
            provider: "openai",
            model: "gpt-4o-mini",
            apiBaseUrl: "http://localhost:9",
          },
        }),
    );
    const byName = new Map(agents.map((a) => [a.name, a]));
    const tasks = t.tasks.map((tk) => {
      const task = new Task({
        id: tk.id,
        title: tk.title,
        description: tk.description,
        expectedOutput: "n/a — read-only bridge",
        agent: byName.get(tk.agent) ?? agents[0],
      });
      task.status = tk.status;
      return task;
    });
    return new Team({ name: t.name, agents, tasks });
  });
}

export default function App() {
  const [teamsJson, setTeamsJson] = useState(null);
  // conn: "connecting" | "live" (green, SSE + fs.watch)
  //       | "polling" (yellow, SSE works but server is in polling fallback)
  //       | "reconnecting" (yellow, SSE dropped; browser auto-reconnects)
  const [conn, setConn] = useState("connecting");

  useEffect(() => {
    let alive = true;
    fetch("/api/teams")
      .then((r) => r.json())
      .then((j) => alive && setTeamsJson(j))
      .catch(() => {});

    const es = new EventSource("/api/events");
    es.onopen = () => setConn((c) => (c === "polling" ? "polling" : "live"));
    es.addEventListener("hello", (e) => {
      const { mode } = JSON.parse(e.data);
      setConn(mode === "poll" ? "polling" : "live");
    });
    es.addEventListener("snapshot", (e) => alive && setTeamsJson(JSON.parse(e.data)));
    es.onerror = () => setConn("reconnecting");

    return () => {
      alive = false;
      es.close();
    };
  }, []);

  // Guard: if kaibanjs construction ever throws (e.g. a future API change),
  // keep the last good teams instead of blanking the page.
  const lastGoodRef = useRef([]);
  const teams = useMemo(() => {
    try {
      const next = toKaibanTeams(teamsJson);
      lastGoodRef.current = next;
      return next;
    } catch (err) {
      console.error("team construction failed:", err);
      return lastGoodRef.current;
    }
  }, [teamsJson]);
  const taskCount = teamsJson?.[0]?.tasks?.length ?? 0;
  const statusByConn = {
    live: { color: "#22c55e", label: "live (fs.watch)" },
    polling: { color: "#eab308", label: "polling fallback" },
    reconnecting: { color: "#eab308", label: "reconnecting…" },
    connecting: { color: "#9ca3af", label: "connecting…" },
  };
  const dot = statusByConn[conn];

  return (
    <div style={{ fontFamily: "system-ui, sans-serif" }}>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "10px 16px",
          borderBottom: "1px solid #e5e7eb",
          background: "#fafafa",
        }}
      >
        <h1 style={{ fontSize: 16, margin: 0 }}>🤖 zCode Agent Board</h1>
        <span style={{ fontSize: 13, color: "#6b7280" }}>
          {taskCount} task{taskCount === 1 ? "" : "s"}
        </span>
        <span
          title={dot.label}
          style={{
            marginLeft: "auto",
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 12,
            color: "#6b7280",
          }}
        >
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: 999,
              background: dot.color,
              display: "inline-block",
            }}
          />
          {dot.label}
        </span>
      </header>
      <KaibanBoard teams={teams} uiSettings={{ showWelcomeInfo: false }} />
    </div>
  );
}
