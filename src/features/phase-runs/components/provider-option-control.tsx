import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { OptionDecl } from "@/features/providers/types";

export function ProviderOptionControl({
  decl,
  value,
  onChange,
}: {
  decl: OptionDecl;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  if (decl.kind === "bool") {
    return (
      <label
        className="text-foreground flex items-center gap-2 text-xs"
        title={decl.description ?? undefined}
      >
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
          className="size-3.5"
        />
        {decl.label}
      </label>
    );
  }
  if (decl.kind === "select") {
    return (
      <div
        className="flex flex-col gap-1"
        title={decl.description ?? undefined}
      >
        <Label className="text-[11px]">{decl.label}</Label>
        <Select
          value={typeof value === "string" ? value : decl.default}
          onValueChange={onChange}
        >
          <SelectTrigger className="h-7 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {decl.choices.map((c) => (
              <SelectItem key={c.value} value={c.value} className="text-xs">
                {c.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    );
  }
  return (
    <div
      className="flex flex-col gap-1"
      title={decl.description ?? undefined}
    >
      <Label className="text-[11px]">{decl.label}</Label>
      <Input
        className="h-7 text-xs"
        value={typeof value === "string" ? value : decl.default}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
