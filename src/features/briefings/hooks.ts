import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { briefingsApi } from "./api";
import type {
  Briefing,
  BriefingEdits,
  BriefingHistoryEntry,
} from "./types";

export const briefingKeys = {
  detail: (id: string) => ["briefing", id] as const,
  listActive: () => ["briefing", "active"] as const,
  history: (id: string) => ["briefing", id, "history"] as const,
};

export function useBriefingHistory(briefingId: string | undefined) {
  return useQuery<BriefingHistoryEntry[]>({
    queryKey: briefingId
      ? briefingKeys.history(briefingId)
      : ["briefing", "__pending__", "history"],
    queryFn: () => briefingsApi.listHistory(briefingId!),
    enabled: !!briefingId,
  });
}

export function useBriefing(briefingId: string | undefined) {
  return useQuery<Briefing | null>({
    queryKey: briefingId
      ? briefingKeys.detail(briefingId)
      : ["briefing", "__pending__"],
    queryFn: () => briefingsApi.get(briefingId!),
    enabled: !!briefingId,
  });
}

export function useActiveBriefings(enabled = true) {
  return useQuery<Briefing[]>({
    queryKey: briefingKeys.listActive(),
    queryFn: briefingsApi.listActive,
    enabled,
  });
}

export function useStartBriefing() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: briefingsApi.start,
    onSuccess: (briefing) => {
      qc.setQueryData(briefingKeys.detail(briefing.id), briefing);
      qc.invalidateQueries({ queryKey: briefingKeys.listActive() });
    },
  });
}

/**
 * Kick off the initial draft generation. Fire-and-forget: the mutation
 * resolves once the backend has appended `BriefingGenerationStarted` and
 * spawned the worker. The completion event lands asynchronously via the
 * global live-updates provider — so callers should drive their UI from
 * `briefing.is_generating` rather than `mutation.isPending`.
 *
 * The returned briefing has `is_generating: true` set; we seed it directly
 * into the cache so the spinner appears without a query round-trip.
 */
export function useGenerateBriefingDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (briefingId: string) => briefingsApi.generate(briefingId),
    onSuccess: (briefing) => {
      qc.setQueryData(briefingKeys.detail(briefing.id), briefing);
      qc.invalidateQueries({ queryKey: briefingKeys.listActive() });
    },
  });
}

export function useApplyBriefingEdits() {
  return useMutation({
    mutationFn: ({
      briefingId,
      edits,
    }: {
      briefingId: string;
      edits: BriefingEdits;
    }) => briefingsApi.applyEdits(briefingId, edits),
  });
}

/**
 * Same contract as {@link useGenerateBriefingDraft} but for refines.
 */
export function useRefineBriefing() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (briefingId: string) => briefingsApi.refine(briefingId),
    onSuccess: (briefing) => {
      qc.setQueryData(briefingKeys.detail(briefing.id), briefing);
      qc.invalidateQueries({ queryKey: briefingKeys.listActive() });
    },
  });
}

export function useAcceptBriefing() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (briefingId: string) => briefingsApi.accept(briefingId),
    onSuccess: (_plan, briefingId) => {
      qc.invalidateQueries({ queryKey: briefingKeys.detail(briefingId) });
      qc.invalidateQueries({ queryKey: ["plan"] });
      qc.invalidateQueries({ queryKey: briefingKeys.listActive() });
    },
  });
}

/**
 * Cancel only the current generation attempt. The briefing remains active
 * — the user can immediately start another generation. Idempotent on the
 * backend; safe to fire even if no generation is running.
 */
export function useCancelBriefingGeneration() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (briefingId: string) =>
      briefingsApi.cancelGeneration(briefingId),
    onSuccess: (_v, briefingId) => {
      qc.invalidateQueries({ queryKey: briefingKeys.detail(briefingId) });
      qc.invalidateQueries({ queryKey: briefingKeys.listActive() });
    },
  });
}

/** Hard-cancel the briefing as a whole (status -> `cancelled`). */
export function useCancelBriefing() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (briefingId: string) => briefingsApi.cancel(briefingId),
    onSuccess: (_v, briefingId) => {
      qc.invalidateQueries({ queryKey: briefingKeys.detail(briefingId) });
      qc.invalidateQueries({ queryKey: briefingKeys.listActive() });
    },
  });
}
