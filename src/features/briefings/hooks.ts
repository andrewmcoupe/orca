import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { briefingsApi } from "./api";
import type {
  Briefing,
  BriefingDraft,
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

export function useGenerateBriefingDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (briefingId: string) => briefingsApi.generate(briefingId),
    onSuccess: (_draft, briefingId) => {
      qc.invalidateQueries({ queryKey: briefingKeys.detail(briefingId) });
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

export function useRefineBriefing() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (briefingId: string) => briefingsApi.refine(briefingId),
    onSuccess: (_draft: BriefingDraft, briefingId) => {
      qc.invalidateQueries({ queryKey: briefingKeys.detail(briefingId) });
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

/**
 * Subscribe to `projection_updated` events for a briefing aggregate and
 * invalidate its detail query so the UI refreshes after backend mutations
 * (drafts produced, edits applied, etc.).
 */
export function useBriefingLiveUpdates(briefingId: string | undefined) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!briefingId) return;
    let cancelled = false;
    const unlistenPromise = listen<{
      aggregate_type: string;
      aggregate_id: string;
    }>("projection_updated", (e) => {
      if (cancelled) return;
      if (
        e.payload.aggregate_type === "briefing" &&
        e.payload.aggregate_id === briefingId
      ) {
        qc.invalidateQueries({ queryKey: briefingKeys.detail(briefingId) });
      }
    });
    return () => {
      cancelled = true;
      void unlistenPromise.then((u) => u());
    };
  }, [briefingId, qc]);
}
