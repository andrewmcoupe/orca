import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { providersApi } from "./api";
import type { KnownModel, ProviderOptionsSchema, ProviderStatus } from "./types";

export function useProviders() {
  return useQuery<ProviderStatus[]>({
    queryKey: ["providers"],
    queryFn: providersApi.list,
  });
}

export function useRefreshProviders() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: providersApi.refresh,
    onSuccess: (data) => qc.setQueryData(["providers"], data),
  });
}

export function useProviderOptions(providerId: string | undefined) {
  return useQuery<ProviderOptionsSchema>({
    queryKey: ["provider_options", providerId ?? "__none__"],
    queryFn: () => providersApi.options(providerId!),
    enabled: !!providerId,
  });
}

export function useProviderModels(providerId: string | undefined) {
  return useQuery<KnownModel[]>({
    queryKey: ["provider_models", providerId ?? "__none__"],
    queryFn: () => providersApi.listModels(providerId!),
    enabled: !!providerId,
  });
}

/** Permission modes the provider exposes for a given phase. Provider-aware so
 * codex (which has a non-deadlocking `plan` mode via `--sandbox read-only`) gets
 * `plan` in the dropdown while claude does not. */
export function usePermissionModes(
  providerId: string | undefined | null,
  phase: string | undefined | null,
) {
  return useQuery<string[]>({
    queryKey: [
      "permission_modes",
      providerId ?? "__none__",
      phase ?? "__none__",
    ],
    queryFn: () => providersApi.listPermissionModes(providerId!, phase!),
    enabled: !!providerId && !!phase,
  });
}
