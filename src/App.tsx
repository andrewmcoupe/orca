import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import "./App.css";

// ---------- Types ----------

type Workspace = {
  id: string;
  path: string;
  name: string;
  archived: boolean;
  archived_reason: string | null;
  created_at: number;
  updated_at: number;
};

type Task = {
  id: string;
  workspace_id: string;
  title: string;
  spec_markdown: string;
  source: string;
  prd_id: string | null;
  status: string;
  cancel_reason: string | null;
  approved_by: string | null;
  merged_commit_sha: string | null;
  merge_strategy: string | null;
  latest_phase_run_id: string | null;
  worktree_path: string | null;
  worktree_branch: string | null;
  worktree_base_commit: string | null;
  worktree_status: string | null;
  worktree_removal_reason: string | null;
  created_at: number;
  updated_at: number;
};

type PhaseRun = {
  id: string;
  task_id: string;
  phase: string;
  provider: string;
  model: string;
  status: string;
  summary: string | null;
  exit_code: number | null;
  error_kind: string | null;
  error_message: string | null;
  files_changed: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  started_at: number;
  completed_at: number | null;
  updated_at: number;
};

type PhaseRunChunk = {
  chunk_seq: number;
  chunk: string;
  created_at: number;
};

type ActiveWorkspaceInfo = { id: string; path: string };

type ProjectionUpdated = {
  workspace_id: string | null;
  aggregate_type: string;
  aggregate_id: string;
};

type ProviderStatus = {
  id: string;
  display_name: string;
  installed: boolean;
  version: string | null;
  authenticated: boolean;
  path: string | null;
  error: string | null;
};

type OptionDecl =
  | {
      kind: "bool";
      id: string;
      label: string;
      description: string | null;
      default: boolean;
    }
  | {
      kind: "select";
      id: string;
      label: string;
      description: string | null;
      default: string;
      choices: { value: string; label: string }[];
    }
  | {
      kind: "text";
      id: string;
      label: string;
      description: string | null;
      default: string;
    };

type ProviderOptionsSchema = {
  provider_id: string;
  schema: OptionDecl[];
  defaults: Record<string, unknown>;
};

type RecentEvent = {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  summary: string;
  created_at: number;
};

// ---------- Global projection_updated listener ----------

function useProjectionInvalidation() {
  const queryClient = useQueryClient();
  useEffect(() => {
    const unlisten = listen<ProjectionUpdated>("projection_updated", (event) => {
      const { aggregate_type, aggregate_id, workspace_id } = event.payload;
      // Wildcard rebuild_projections payload — invalidate everything.
      if (aggregate_id === "*") {
        queryClient.invalidateQueries();
        return;
      }
      queryClient.invalidateQueries({ queryKey: [aggregate_type, aggregate_id] });
      queryClient.invalidateQueries({
        queryKey: [aggregate_type, "list", workspace_id],
      });
      // Recent events strip is its own query — invalidated on every event so it stays fresh.
      if (aggregate_type !== "recent_events") {
        queryClient.invalidateQueries({ queryKey: ["recent_events", workspace_id] });
      } else {
        queryClient.invalidateQueries({ queryKey: ["recent_events"] });
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [queryClient]);
}

// ---------- Components ----------

function App() {
  useProjectionInvalidation();

  const queryClient = useQueryClient();
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  const workspacesQ = useQuery<Workspace[]>({
    queryKey: ["workspace", "list", null],
    queryFn: () => invoke<Workspace[]>("list_workspaces"),
  });

  const activeQ = useQuery<ActiveWorkspaceInfo | null>({
    queryKey: ["active_workspace"],
    queryFn: () => invoke<ActiveWorkspaceInfo | null>("get_active_workspace"),
  });

  const addWorkspaceM = useMutation({
    mutationFn: async () => {
      const selected = await open({ directory: true });
      if (typeof selected !== "string") return null;
      return invoke<Workspace>("add_workspace", { path: selected });
    },
  });

  const removeWorkspaceM = useMutation({
    mutationFn: (id: string) => invoke("remove_workspace", { id }),
  });

  const setActiveM = useMutation({
    mutationFn: (id: string) => invoke<ActiveWorkspaceInfo>("set_active_workspace", { id }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["active_workspace"] });
      queryClient.invalidateQueries({ queryKey: ["task", "list"] });
      setSelectedTaskId(null);
    },
  });

  const rebuildM = useMutation({
    mutationFn: () => invoke<{ events_replayed: number; projections_rebuilt: string[] }>(
      "rebuild_projections",
      {},
    ),
  });

  const error =
    workspacesQ.error || activeQ.error || addWorkspaceM.error || removeWorkspaceM.error ||
    setActiveM.error || rebuildM.error;

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", display: "flex", flexDirection: "column", height: "100vh" }}>
      <main style={{ padding: 16, display: "flex", gap: 24, flex: 1, overflow: "auto" }}>
      <aside style={{ width: 280 }}>
        <h2>Workspaces</h2>
        <button type="button" onClick={() => addWorkspaceM.mutate()}>
          Add workspace
        </button>
        <button
          type="button"
          onClick={() => setShowSettings((v) => !v)}
          style={{ marginLeft: 8 }}
        >
          {showSettings ? "Hide settings" : "Settings"}
        </button>
        <button
          type="button"
          onClick={() => rebuildM.mutate()}
          style={{ marginLeft: 8 }}
          title="Rebuild all projections from events"
        >
          Rebuild projections
        </button>
        {rebuildM.data && (
          <p style={{ fontSize: 12 }}>
            Replayed {rebuildM.data.events_replayed} events; rebuilt:{" "}
            {rebuildM.data.projections_rebuilt.join(", ")}
          </p>
        )}
        <ul style={{ listStyle: "none", padding: 0 }}>
          {(workspacesQ.data ?? []).map((ws) => {
            const isActive = activeQ.data?.id === ws.id;
            return (
              <li key={ws.id} style={{ marginBottom: 8 }}>
                <button
                  type="button"
                  onClick={() => setActiveM.mutate(ws.id)}
                  style={{
                    fontWeight: isActive ? "bold" : "normal",
                    background: isActive ? "#cdf" : undefined,
                  }}
                >
                  {ws.name}
                </button>
                <div style={{ fontSize: 11, color: "#666" }}>{ws.path}</div>
                <button type="button" onClick={() => removeWorkspaceM.mutate(ws.id)}>
                  Remove
                </button>
              </li>
            );
          })}
        </ul>
      </aside>

      <section style={{ flex: 1 }}>
        {error && <p style={{ color: "red" }}>{String(error)}</p>}
        {showSettings ? (
          <SettingsPanel />
        ) : !activeQ.data ? (
          <p>Select a workspace to begin.</p>
        ) : (
          <WorkspaceView
            workspaceId={activeQ.data.id}
            selectedTaskId={selectedTaskId}
            onSelectTask={setSelectedTaskId}
          />
        )}
      </section>
      </main>
      <EventStreamStrip activeWorkspaceId={activeQ.data?.id ?? null} />
    </div>
  );
}

function SettingsPanel() {
  const providersQ = useQuery<ProviderStatus[]>({
    queryKey: ["providers"],
    queryFn: () => invoke<ProviderStatus[]>("list_providers"),
  });
  const queryClient = useQueryClient();
  const refreshM = useMutation({
    mutationFn: () => invoke<ProviderStatus[]>("refresh_providers"),
    onSuccess: (data) => {
      queryClient.setQueryData(["providers"], data);
    },
  });
  return (
    <div>
      <h2>Settings</h2>
      <h3>Providers</h3>
      <button type="button" onClick={() => refreshM.mutate()} disabled={refreshM.isPending}>
        {refreshM.isPending ? "Refreshing…" : "Refresh"}
      </button>
      <ul style={{ listStyle: "none", padding: 0, marginTop: 12 }}>
        {(providersQ.data ?? []).map((p) => (
          <li
            key={p.id}
            style={{
              border: "1px solid #ddd",
              borderRadius: 4,
              padding: 8,
              marginBottom: 8,
            }}
          >
            <div style={{ fontWeight: 600 }}>
              {p.display_name}{" "}
              <span style={{ fontWeight: 400, color: p.installed ? "#080" : "#b00" }}>
                {p.installed ? "✓ installed" : "✗ not installed"}
              </span>
            </div>
            {p.version && <div style={{ fontSize: 12 }}>Version: {p.version}</div>}
            {p.path && <div style={{ fontSize: 11, color: "#666" }}>{p.path}</div>}
            <div style={{ fontSize: 12 }}>
              Authenticated: {p.authenticated ? "yes" : "unknown"}
            </div>
            {p.error && (
              <div style={{ fontSize: 12, color: "#b00", marginTop: 4 }}>
                {p.error}{" "}
                <a
                  href="https://docs.claude.com/en/docs/claude-code/overview"
                  target="_blank"
                  rel="noreferrer"
                >
                  Install docs
                </a>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function EventStreamStrip({ activeWorkspaceId }: { activeWorkspaceId: string | null }) {
  const recentQ = useQuery<RecentEvent[]>({
    queryKey: ["recent_events", activeWorkspaceId],
    queryFn: () => invoke<RecentEvent[]>("list_recent_events", { limit: 100 }),
    enabled: !!activeWorkspaceId,
  });

  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !followRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [recentQ.data]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
    followRef.current = atBottom;
  };

  // Newest at the bottom (terminal-style). Backend returns DESC; reverse for display.
  const events = (recentQ.data ?? []).slice().reverse();

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      style={{
        height: 80,
        overflowY: "auto",
        borderTop: "1px solid #ddd",
        background: "#fafafa",
        fontFamily: "ui-monospace, SFMono-Regular, monospace",
        fontSize: 11,
        padding: 4,
      }}
    >
      {!activeWorkspaceId && (
        <div style={{ color: "#888" }}>No active workspace.</div>
      )}
      {events.map((e) => (
        <div key={e.id} style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
          <span style={{ color: "#888" }}>{formatTime(e.created_at)}</span>
          <span
            style={{
              background: badgeColor(e.event_type),
              color: "#fff",
              padding: "0 4px",
              borderRadius: 3,
              minWidth: 110,
              display: "inline-block",
              textAlign: "center",
            }}
          >
            {e.event_type}
          </span>
          <span>{e.summary}</span>
        </div>
      ))}
    </div>
  );
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function badgeColor(eventType: string): string {
  if (eventType.startsWith("Task")) return "#3b82f6";
  if (eventType === "PhaseRunStarted") return "#10b981";
  if (eventType === "PhaseRunCompleted") return "#059669";
  if (eventType === "PhaseRunFailed") return "#dc2626";
  if (eventType === "PhaseRunOutputAppended") return "#6b7280";
  if (eventType.startsWith("PhaseRun")) return "#8b5cf6";
  if (eventType === "GateRan") return "#f59e0b";
  return "#475569";
}

function WorkspaceView({
  workspaceId,
  selectedTaskId,
  onSelectTask,
}: {
  workspaceId: string;
  selectedTaskId: string | null;
  onSelectTask: (id: string | null) => void;
}) {
  const tasksQ = useQuery<Task[]>({
    queryKey: ["task", "list", workspaceId],
    queryFn: () => invoke<Task[]>("list_tasks"),
  });

  return (
    <div style={{ display: "flex", gap: 24 }}>
      <div style={{ width: 320 }}>
        <h2>Tasks</h2>
        <CreateTaskForm />
        <ul style={{ listStyle: "none", padding: 0 }}>
          {(tasksQ.data ?? []).map((t) => (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => onSelectTask(t.id)}
                style={{
                  fontWeight: selectedTaskId === t.id ? "bold" : "normal",
                  textAlign: "left",
                  width: "100%",
                }}
              >
                {t.title}{" "}
                <span style={{ fontSize: 11, color: "#888" }}>({t.status})</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div style={{ flex: 1 }}>
        {selectedTaskId ? (
          <TaskDetail workspaceId={workspaceId} taskId={selectedTaskId} />
        ) : (
          <p>Select a task.</p>
        )}
      </div>
    </div>
  );
}

function CreateTaskForm() {
  const [title, setTitle] = useState("");
  const [spec, setSpec] = useState("");
  const create = useMutation({
    mutationFn: () =>
      invoke<Task>("create_task", { title, specMarkdown: spec }),
    onSuccess: () => {
      setTitle("");
      setSpec("");
    },
  });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!title.trim()) return;
        create.mutate();
      }}
      style={{ marginBottom: 12 }}
    >
      <input
        placeholder="Task title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        style={{ display: "block", width: "100%", marginBottom: 4 }}
      />
      <textarea
        placeholder="Spec markdown"
        value={spec}
        onChange={(e) => setSpec(e.target.value)}
        rows={3}
        style={{ display: "block", width: "100%", marginBottom: 4 }}
      />
      <button type="submit">Create task</button>
      {create.error && (
        <p style={{ color: "red" }}>{String(create.error)}</p>
      )}
    </form>
  );
}

function TaskDetail({ workspaceId, taskId }: { workspaceId: string; taskId: string }) {
  const taskQ = useQuery<Task | null>({
    queryKey: ["task", taskId],
    queryFn: () => invoke<Task | null>("get_task", { id: taskId }),
  });
  // Key prefix matches the listener convention [aggregate_type, "list", workspace_id]
  // so backend-emitted projection_updated events invalidate this query.
  const phasesQ = useQuery<PhaseRun[]>({
    queryKey: ["phase_run", "list", workspaceId, taskId],
    queryFn: () => invoke<PhaseRun[]>("list_phase_runs", { taskId }),
  });
  const startFake = useMutation({
    mutationFn: () =>
      invoke<string>("start_fake_phase", { taskId, phase: "implementer" }),
  });
  const startReal = useMutation({
    mutationFn: (vars: { providerId: string; options: Record<string, unknown> }) =>
      invoke<string>("start_real_phase", {
        taskId,
        phase: "implementer",
        providerId: vars.providerId,
        options: vars.options,
      }),
  });

  if (!taskQ.data) return <p>Loading task…</p>;
  return (
    <div>
      <h2>{taskQ.data.title}</h2>
      <p style={{ color: "#666" }}>
        Status: {taskQ.data.status} · Source: {taskQ.data.source}
      </p>
      <pre
        style={{
          whiteSpace: "pre-wrap",
          background: "#f4f4f4",
          padding: 8,
          fontSize: 12,
        }}
      >
        {taskQ.data.spec_markdown || "(no spec)"}
      </pre>

      <button type="button" onClick={() => startFake.mutate()}>
        Run (fake)
      </button>
      <RunRealForm
        onRun={(providerId, options) => startReal.mutate({ providerId, options })}
        pending={startReal.isPending}
      />
      {startFake.error && <p style={{ color: "red" }}>{String(startFake.error)}</p>}
      {startReal.error && <p style={{ color: "red" }}>{String(startReal.error)}</p>}

      <h3>Phase runs</h3>
      {(phasesQ.data ?? []).length === 0 && <p>No phase runs yet.</p>}
      {(phasesQ.data ?? []).map((pr) => (
        <PhaseRunCard key={pr.id} phaseRun={pr} />
      ))}
    </div>
  );
}

function RunRealForm({
  onRun,
  pending,
}: {
  onRun: (providerId: string, options: Record<string, unknown>) => void;
  pending: boolean;
}) {
  const providersQ = useQuery<ProviderStatus[]>({
    queryKey: ["providers"],
    queryFn: () => invoke<ProviderStatus[]>("list_providers"),
  });

  const installed = (providersQ.data ?? []).filter((p) => p.installed);
  const [providerId, setProviderId] = useState<string>("");
  const effectiveProviderId = providerId || installed[0]?.id || "";

  const optionsQ = useQuery<ProviderOptionsSchema>({
    queryKey: ["provider_options", effectiveProviderId],
    queryFn: () =>
      invoke<ProviderOptionsSchema>("get_provider_options", {
        providerId: effectiveProviderId,
      }),
    enabled: !!effectiveProviderId,
  });

  const [overrides, setOverrides] = useState<Record<string, unknown>>({});
  // Reset overrides when switching providers.
  useEffect(() => {
    setOverrides({});
  }, [effectiveProviderId]);

  const merged: Record<string, unknown> = {
    ...(optionsQ.data?.defaults ?? {}),
    ...overrides,
  };

  if (installed.length === 0) {
    return (
      <p style={{ color: "#888", marginTop: 8 }}>
        No installed providers. Open Settings to check.
      </p>
    );
  }

  return (
    <div style={{ marginLeft: 8, display: "inline-block", verticalAlign: "top" }}>
      <select
        value={effectiveProviderId}
        onChange={(e) => setProviderId(e.target.value)}
      >
        {installed.map((p) => (
          <option key={p.id} value={p.id}>
            {p.display_name}
          </option>
        ))}
      </select>
      {(optionsQ.data?.schema ?? []).map((decl) => (
        <ProviderOptionControl
          key={decl.id}
          decl={decl}
          value={merged[decl.id]}
          onChange={(v) => setOverrides((prev) => ({ ...prev, [decl.id]: v }))}
        />
      ))}
      <button
        type="button"
        onClick={() => onRun(effectiveProviderId, merged)}
        disabled={pending}
        style={{ marginLeft: 8 }}
      >
        Run (real)
      </button>
    </div>
  );
}

function ProviderOptionControl({
  decl,
  value,
  onChange,
}: {
  decl: OptionDecl;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const labelStyle = { fontSize: 12, marginLeft: 8 };
  if (decl.kind === "bool") {
    return (
      <label style={labelStyle} title={decl.description ?? undefined}>
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
        />
        {decl.label}
      </label>
    );
  }
  if (decl.kind === "select") {
    return (
      <label style={labelStyle} title={decl.description ?? undefined}>
        {decl.label}{" "}
        <select
          value={typeof value === "string" ? value : decl.default}
          onChange={(e) => onChange(e.target.value)}
        >
          {decl.choices.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
    );
  }
  return (
    <label style={labelStyle} title={decl.description ?? undefined}>
      {decl.label}{" "}
      <input
        type="text"
        value={typeof value === "string" ? value : decl.default}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function PhaseRunCard({ phaseRun }: { phaseRun: PhaseRun }) {
  const outputQ = useQuery<PhaseRunChunk[]>({
    queryKey: ["phase_run", phaseRun.id, "output"],
    queryFn: () =>
      invoke<PhaseRunChunk[]>("list_phase_run_output", { phaseRunId: phaseRun.id }),
  });
  const cancel = useMutation({
    mutationFn: () => invoke<boolean>("cancel_phase_run", { phaseRunId: phaseRun.id }),
  });
  return (
    <div
      style={{
        border: "1px solid #ddd",
        padding: 8,
        marginBottom: 8,
        borderRadius: 4,
      }}
    >
      <div style={{ fontSize: 13 }}>
        <strong>{phaseRun.phase}</strong> · {phaseRun.provider} / {phaseRun.model} ·{" "}
        <em>{phaseRun.status}</em>
      </div>
      {phaseRun.summary && <div style={{ fontSize: 12 }}>{phaseRun.summary}</div>}
      {phaseRun.status === "running" && (
        <button
          type="button"
          onClick={() => cancel.mutate()}
          disabled={cancel.isPending}
          style={{ marginBottom: 4 }}
        >
          Cancel
        </button>
      )}
      <pre
        style={{
          background: "#000",
          color: "#0f0",
          padding: 8,
          fontSize: 12,
          maxHeight: 200,
          overflow: "auto",
          margin: 0,
          whiteSpace: "pre-wrap",
        }}
      >
        {(outputQ.data ?? []).map((c) => c.chunk).join("")}
      </pre>
    </div>
  );
}

export default App;
