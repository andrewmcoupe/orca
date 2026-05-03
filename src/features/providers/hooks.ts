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
