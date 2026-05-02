export type ProviderStatus = {
  id: string;
  display_name: string;
  installed: boolean;
  version: string | null;
  authenticated: boolean;
  path: string | null;
  error: string | null;
};

export type OptionDecl =
  | {
      kind: "bool";
      id: string;
      label: string;
      description: string | null;
      default: boolean;
    }
  | {
      kind: "select";
      id: string;
      label: string;
      description: string | null;
      default: string;
      choices: { value: string; label: string }[];
    }
  | {
      kind: "text";
      id: string;
      label: string;
      description: string | null;
      default: string;
    };

export type ProviderOptionsSchema = {
  provider_id: string;
  schema: OptionDecl[];
  defaults: Record<string, unknown>;
};
