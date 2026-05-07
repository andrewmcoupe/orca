import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useProviders, useProviderOptions } from "@/features/providers/hooks";
import { ProviderOptionControl } from "./provider-option-control";

export function RunRealForm({
  onRun,
  pending,
}: {
  onRun: (providerId: string, options: Record<string, unknown>) => void;
  pending: boolean;
}) {
  const providers = useProviders();
  const installed = (providers.data ?? []).filter((p) => p.installed);
  const [providerId, setProviderId] = useState<string>("");
  const effectiveProviderId = providerId || installed[0]?.id || "";

  const optionsQ = useProviderOptions(effectiveProviderId || undefined);
  const [overrides, setOverrides] = useState<Record<string, unknown>>({});

  useEffect(() => {
    setOverrides({});
  }, [effectiveProviderId]);

  if (installed.length === 0) {
    return (
      <p className="text-muted-foreground text-xs">
        No installed providers. See Providers tab.
      </p>
    );
  }

  const merged: Record<string, unknown> = {
    ...(optionsQ.data?.defaults ?? {}),
    ...overrides,
  };

  return (
    <div className="bg-muted/20 flex flex-wrap items-end gap-3 rounded-md border p-2">
      <div className="flex flex-col gap-1">
        <span className="text-[11px] font-medium">Provider</span>
        <Select
          value={effectiveProviderId}
          onValueChange={(v) => setProviderId(v ?? "")}
        >
          <SelectTrigger className="h-7 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {installed.map((p) => (
              <SelectItem key={p.id} value={p.id} className="text-xs">
                {p.display_name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {(optionsQ.data?.schema ?? []).map((decl) => (
        <ProviderOptionControl
          key={decl.id}
          decl={decl}
          value={merged[decl.id]}
          onChange={(v) =>
            setOverrides((prev) => ({ ...prev, [decl.id]: v }))
          }
        />
      ))}
      <Button
        size="sm"
        onClick={() => onRun(effectiveProviderId, merged)}
        disabled={pending || !effectiveProviderId}
      >
        Run
      </Button>
    </div>
  );
}
