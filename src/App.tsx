import { useEffect, useState } from "react";
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
  workspace_id: string;
  aggregate_type: string;
  aggregate_id: string;
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
      // For phase_run output, key is [phase_run, id, "output"].
      if (aggregate_type === "phase_run") {
        queryClient.invalidateQueries({ queryKey: ["phase_run", aggregate_id, "output"] });
        queryClient.invalidateQueries({ queryKey: ["phase_run", "list", workspace_id] });
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
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 16, display: "flex", gap: 24 }}>
      <aside style={{ width: 280 }}>
        <h2>Workspaces</h2>
        <button type="button" onClick={() => addWorkspaceM.mutate()}>
          Add workspace
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
        {!activeQ.data ? (
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
  );
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
          <TaskDetail taskId={selectedTaskId} />
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

function TaskDetail({ taskId }: { taskId: string }) {
  const taskQ = useQuery<Task | null>({
    queryKey: ["task", taskId],
    queryFn: () => invoke<Task | null>("get_task", { id: taskId }),
  });
  const phasesQ = useQuery<PhaseRun[]>({
    queryKey: ["phase_run", "list", taskId],
    queryFn: () => invoke<PhaseRun[]>("list_phase_runs", { taskId }),
  });
  const start = useMutation({
    mutationFn: () =>
      invoke<string>("start_fake_phase", { taskId, phase: "implementer" }),
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

      <button type="button" onClick={() => start.mutate()}>
        Run fake implementer
      </button>
      {start.error && <p style={{ color: "red" }}>{String(start.error)}</p>}

      <h3>Phase runs</h3>
      {(phasesQ.data ?? []).length === 0 && <p>No phase runs yet.</p>}
      {(phasesQ.data ?? []).map((pr) => (
        <PhaseRunCard key={pr.id} phaseRun={pr} />
      ))}
    </div>
  );
}

function PhaseRunCard({ phaseRun }: { phaseRun: PhaseRun }) {
  const outputQ = useQuery<PhaseRunChunk[]>({
    queryKey: ["phase_run", phaseRun.id, "output"],
    queryFn: () =>
      invoke<PhaseRunChunk[]>("list_phase_run_output", { phaseRunId: phaseRun.id }),
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
