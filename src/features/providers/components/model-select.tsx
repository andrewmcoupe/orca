import { useQueries } from "@tanstack/react-query";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { providersApi } from "../api";
import { useProviders } from "../hooks";
import type { KnownModel, ProviderStatus } from "../types";
import type { ModelChoice } from "@/features/workspaces/types";

const NULL_VALUE = "__null__";

function encode(c: ModelChoice): string {
  return `${c.provider}::${c.model}`;
}

function decode(s: string | null): ModelChoice | null {
  if (s == null || s === NULL_VALUE) return null;
  const idx = s.indexOf("::");
  if (idx <= 0 || idx >= s.length - 2) return null;
  return { provider: s.slice(0, idx), model: s.slice(idx + 2) };
}

/**
 * Dropdown selecting a `(provider, model)` pair. Lists all known models from every
 * registered provider plus a sentinel "use default" option that yields `null`.
 */
export function ModelSelect({
  value,
  onChange,
  nullLabel,
  disabled,
  size = "default",
}: {
  value: ModelChoice | null;
  onChange: (next: ModelChoice | null) => void;
  nullLabel: string;
  disabled?: boolean;
  size?: "sm" | "default";
}) {
  const providersQ = useProviders();
  const providers: ProviderStatus[] = providersQ.data ?? [];

  const modelQueries = useQueries({
    queries: providers.map((p) => ({
      queryKey: ["provider_models", p.id],
      queryFn: () => providersApi.listModels(p.id),
      enabled: providers.length > 0,
    })),
  });

  const grouped: Array<{ provider: ProviderStatus; models: KnownModel[] }> =
    providers.map((p, i) => ({
      provider: p,
      models: modelQueries[i]?.data ?? [],
    }));

  const selectedValue = value ? encode(value) : NULL_VALUE;

  return (
    <Select
      value={selectedValue}
      onValueChange={(v) => onChange(decode(v))}
      disabled={disabled}
    >
      <SelectTrigger size={size === "sm" ? "sm" : "default"} className="w-full">
        <SelectValue placeholder={nullLabel} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NULL_VALUE}>
          <span className="text-muted-foreground">{nullLabel}</span>
        </SelectItem>
        {grouped.map(({ provider, models }) =>
          models.length > 0 ? (
            <SelectGroup key={provider.id}>
              <SelectLabel>{provider.display_name}</SelectLabel>
              {models.map((m) => (
                <SelectItem key={`${provider.id}::${m.id}`} value={encode({ provider: provider.id, model: m.id })}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectGroup>
          ) : null,
        )}
      </SelectContent>
    </Select>
  );
}
