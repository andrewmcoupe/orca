import { useEffect, useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
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
    mutationFn: ({
      briefingId,
      acceptAssumptions,
    }: {
      briefingId: string;
      acceptAssumptions?: boolean;
    }) => briefingsApi.accept(briefingId, acceptAssumptions ?? false),
    onSuccess: (_plan, vars) => {
      const briefingId = vars.briefingId;
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

/**
 * Subscribe to live LLM text chunks for a briefing while it's generating.
 * Backed by the `briefing_chunk` Tauri event emitted from `briefing.rs`.
 *
 * Ephemeral by design (option 2 of the planned rollout): the buffer lives in
 * component state, not the DB — refreshing the page or unmounting clears it.
 * `reset` lets callers wipe the buffer when a new generation starts.
 */
type BriefingChunkPayload = { briefing_id: string; text: string };

export function useBriefingLiveOutput(
  briefingId: string | undefined,
  active: boolean,
) {
  const [text, setText] = useState("");
  useEffect(() => {
    if (!briefingId || !active) return;
    let cancelled = false;
    const unlisten = listen<BriefingChunkPayload>("briefing_chunk", (e) => {
      if (cancelled) return;
      if (e.payload.briefing_id !== briefingId) return;
      setText((prev) => prev + e.payload.text);
    });
    return () => {
      cancelled = true;
      unlisten.then((fn) => fn());
    };
  }, [briefingId, active]);
  // When generation flips off (success/cancel/fail) we keep the text on screen
  // until the briefing record changes — the parent component decides to clear.
  return { text, reset: () => setText("") };
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
