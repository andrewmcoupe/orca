import { invoke } from "@tauri-apps/api/core";
import type { KnownModel, ProviderOptionsSchema, ProviderStatus } from "./types";

export const providersApi = {
  list: () => invoke<ProviderStatus[]>("list_providers"),
  refresh: () => invoke<ProviderStatus[]>("refresh_providers"),
  options: (providerId: string) =>
    invoke<ProviderOptionsSchema>("get_provider_options", { providerId }),
  listModels: (providerId: string) =>
    invoke<KnownModel[]>("list_models", { providerId }),
  listPermissionModes: (providerId: string, phase: string) =>
    invoke<string[]>("list_permission_modes", { providerId, phase }),
};
