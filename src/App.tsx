import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import "./App.css";

type Workspace = {
  id: string;
  path: string;
  name: string;
  added_at: number;
  last_opened_at: number | null;
};

function App() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      const list = await invoke<Workspace[]>("list_workspaces");
      setWorkspaces(list);
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function addWorkspace() {
    setError(null);
    try {
      const selected = await open({ directory: true });
      if (typeof selected !== "string") return;
      await invoke("add_workspace", { path: selected });
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  async function removeWorkspace(id: string) {
    setError(null);
    try {
      await invoke("remove_workspace", { id });
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <main className="container">
      <h1>Workspaces</h1>

      <button type="button" onClick={addWorkspace}>
        Add workspace
      </button>

      {error && <p style={{ color: "red" }}>{error}</p>}

      <ul>
        {workspaces.map((ws) => (
          <li key={ws.id}>
            <strong>{ws.name}</strong> — <span>{ws.path}</span>
            <button type="button" onClick={() => removeWorkspace(ws.id)}>
              Remove
            </button>
          </li>
        ))}
      </ul>
    </main>
  );
}

export default App;
