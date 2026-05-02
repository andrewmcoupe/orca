import { invoke } from "@tauri-apps/api/core";
import type { ProviderOptionsSchema, ProviderStatus } from "./types";

export const providersApi = {
  list: () => invoke<ProviderStatus[]>("list_providers"),
  refresh: () => invoke<ProviderStatus[]>("refresh_providers"),
  options: (providerId: string) =>
    invoke<ProviderOptionsSchema>("get_provider_options", { providerId }),
};
