import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { providersApi } from "./api";
import type { ProviderOptionsSchema, ProviderStatus } from "./types";

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
