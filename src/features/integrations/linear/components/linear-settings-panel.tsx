import { useState } from "react";
import { Check, Plugs, Trash, Warning } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LinearLogo } from "./linear-logo";
import {
  useDisconnectLinear,
  useLinearConnectionStatus,
  useSaveLinearApiKey,
} from "../hooks";
import { linearApi } from "../api";

export function LinearSettingsPanel() {
  const status = useLinearConnectionStatus();
  const save = useSaveLinearApiKey();
  const disconnect = useDisconnectLinear();
  const [apiKey, setApiKey] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const connected = status.data?.connected ?? false;
  const busy = status.isLoading || save.isPending || disconnect.isPending;

  const saveKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!apiKey.trim()) return;
    setMessage(null);
    setError(null);
    try {
      const user = await save.mutateAsync(apiKey);
      setApiKey("");
      setMessage(`Connected as ${user.display_name ?? user.name ?? user.id}.`);
    } catch (err) {
      setError(String(err));
    }
  };

  const testConnection = async () => {
    setMessage(null);
    setError(null);
    try {
      const user = await linearApi.testConnection();
      setMessage(`Connection OK: ${user.display_name ?? user.name ?? user.id}.`);
    } catch (err) {
      setError(String(err));
    }
  };

  const removeKey = async () => {
    setMessage(null);
    setError(null);
    try {
      await disconnect.mutateAsync();
      setApiKey("");
      setMessage("Linear API key removed.");
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <LinearLogo className="size-4" />
          <div>
            <h3 className="text-sm font-medium">Linear</h3>
            <p className="text-muted-foreground text-xs">
              Import Linear issues into new briefings for this workspace.
            </p>
          </div>
        </div>
        <ConnectionState connected={connected} loading={status.isLoading} />
      </div>

      <form onSubmit={saveKey} className="space-y-2">
        <Label htmlFor="workspace-linear-api-key" className="text-xs">
          {connected ? "Replace API key" : "API key"}
        </Label>
        <div className="flex gap-2">
          <Input
            id="workspace-linear-api-key"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="lin_api_..."
            disabled={busy}
            autoComplete="off"
          />
          <Button type="submit" disabled={!apiKey.trim() || busy}>
            <Plugs />
            {connected ? "Update" : "Connect"}
          </Button>
        </div>
        <p className="text-muted-foreground text-[11px]">
          Stored in the system credential store and scoped to the active Orca workspace.
        </p>
      </form>

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={testConnection}
          disabled={!connected || busy}
        >
          Test connection
        </Button>
        <Button
          type="button"
          variant="destructive"
          size="sm"
          onClick={removeKey}
          disabled={!connected || busy}
        >
          <Trash />
          Disconnect
        </Button>
      </div>

      {message && (
        <p className="text-success inline-flex items-center gap-1 text-xs">
          <Check className="size-3" />
          {message}
        </p>
      )}
      {(error || status.error) && (
        <p className="text-destructive inline-flex items-start gap-1 text-xs">
          <Warning className="mt-0.5 size-3 shrink-0" />
          <span>{String(error ?? status.error)}</span>
        </p>
      )}
    </div>
  );
}

function ConnectionState({
  connected,
  loading,
}: {
  connected: boolean;
  loading: boolean;
}) {
  if (loading) {
    return <span className="text-muted-foreground text-xs">Checking...</span>;
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs">
      <span
        className={
          connected
            ? "bg-success size-1.5 rounded-full"
            : "bg-muted-foreground/40 size-1.5 rounded-full"
        }
      />
      {connected ? "Connected" : "Not connected"}
    </span>
  );
}
