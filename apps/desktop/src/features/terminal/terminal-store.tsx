import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  type ReactNode,
} from "react";
import { listen } from "@tauri-apps/api/event";
import { terminalApi } from "@/features/terminal/api";
import type {
  TerminalExitEvent,
  TerminalLabelEvent,
  TerminalSessionInfo,
} from "@/features/terminal/types";

export type TerminalTab = {
  id: string;
  title: string;
  session: TerminalSessionInfo;
};

export type TerminalGroupState = {
  tabs: TerminalTab[];
  activeTabId: string | null;
  collapsed: boolean;
  hydrated: boolean;
};

type State = {
  groups: Record<string, TerminalGroupState>;
};

type Action =
  | {
      type: "hydrate";
      scopeKey: string;
      sessions: TerminalSessionInfo[];
    }
  | { type: "add"; scopeKey: string; session: TerminalSessionInfo }
  | { type: "close"; scopeKey: string; terminalId: string }
  | { type: "select"; scopeKey: string; terminalId: string }
  | { type: "setCollapsed"; scopeKey: string; collapsed: boolean }
  | { type: "label"; terminalId: string; label: string }
  | { type: "exited"; terminalId: string };

type TerminalStore = {
  group: (workspaceId: string, taskId: string) => TerminalGroupState;
  hydrateTask: (workspaceId: string, taskId: string) => Promise<void>;
  openTerminal: (workspaceId: string, taskId: string) => Promise<void>;
  closeTerminal: (
    workspaceId: string,
    taskId: string,
    terminalId: string,
  ) => Promise<void>;
  selectTerminal: (
    workspaceId: string,
    taskId: string,
    terminalId: string,
  ) => void;
  toggleCollapsed: (workspaceId: string, taskId: string) => void;
  renameTerminal: (terminalId: string, label: string) => void;
};

const EMPTY_GROUP: TerminalGroupState = {
  tabs: [],
  activeTabId: null,
  collapsed: false,
  hydrated: false,
};

const TerminalStoreContext = createContext<TerminalStore | null>(null);

export function TerminalStoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, { groups: {} });

  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    let cancelled = false;

    void (async () => {
      const unlistenLabel = await listen<TerminalLabelEvent>(
        "terminal_label",
        (event) => {
          dispatch({
            type: "label",
            terminalId: event.payload.terminal_id,
            label: event.payload.label,
          });
        },
      );
      if (cancelled) {
        unlistenLabel();
      } else {
        unlisteners.push(unlistenLabel);
      }

      const unlistenExit = await listen<TerminalExitEvent>(
        "terminal_exit",
        (event) => {
          dispatch({ type: "exited", terminalId: event.payload.terminal_id });
        },
      );
      if (cancelled) {
        unlistenExit();
      } else {
        unlisteners.push(unlistenExit);
      }
    })();

    return () => {
      cancelled = true;
      for (const unlisten of unlisteners) unlisten();
    };
  }, []);

  const group = useCallback(
    (workspaceId: string, taskId: string) =>
      state.groups[scopeKey(workspaceId, taskId)] ?? EMPTY_GROUP,
    [state.groups],
  );

  const hydrateTask = useCallback(async (workspaceId: string, taskId: string) => {
    const sessions = await terminalApi.listForTask(workspaceId, taskId);
    dispatch({
      type: "hydrate",
      scopeKey: scopeKey(workspaceId, taskId),
      sessions,
    });
  }, []);

  const openTerminal = useCallback(
    async (workspaceId: string, taskId: string) => {
      const session = await terminalApi.create(taskId, 120, 18);
      dispatch({
        type: "add",
        scopeKey: scopeKey(workspaceId, taskId),
        session,
      });
    },
    [],
  );

  const closeTerminal = useCallback(
    async (workspaceId: string, taskId: string, terminalId: string) => {
      dispatch({
        type: "close",
        scopeKey: scopeKey(workspaceId, taskId),
        terminalId,
      });
      try {
        await terminalApi.close(terminalId);
      } catch {
        /* Missing sessions are already absent from the local tab model. */
      }
    },
    [],
  );

  const selectTerminal = useCallback(
    (workspaceId: string, taskId: string, terminalId: string) => {
      dispatch({
        type: "select",
        scopeKey: scopeKey(workspaceId, taskId),
        terminalId,
      });
    },
    [],
  );

  const toggleCollapsed = useCallback((workspaceId: string, taskId: string) => {
    const current = state.groups[scopeKey(workspaceId, taskId)] ?? EMPTY_GROUP;
    dispatch({
      type: "setCollapsed",
      scopeKey: scopeKey(workspaceId, taskId),
      collapsed: !current.collapsed,
    });
  }, [state.groups]);

  const renameTerminal = useCallback((terminalId: string, label: string) => {
    dispatch({ type: "label", terminalId, label });
  }, []);

  const value = useMemo<TerminalStore>(
    () => ({
      group,
      hydrateTask,
      openTerminal,
      closeTerminal,
      selectTerminal,
      toggleCollapsed,
      renameTerminal,
    }),
    [
      closeTerminal,
      group,
      hydrateTask,
      openTerminal,
      renameTerminal,
      selectTerminal,
      toggleCollapsed,
    ],
  );

  return (
    <TerminalStoreContext.Provider value={value}>
      {children}
    </TerminalStoreContext.Provider>
  );
}

export function useTerminalStore() {
  const value = useContext(TerminalStoreContext);
  if (!value) {
    throw new Error("useTerminalStore must be used inside TerminalStoreProvider");
  }
  return value;
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "hydrate": {
      const current = state.groups[action.scopeKey] ?? EMPTY_GROUP;
      const known = new Set(current.tabs.map((tab) => tab.id));
      const added = action.sessions
        .filter((session) => !known.has(session.terminal_id))
        .map(tabFromSession);
      const tabs = current.tabs
        .filter((tab) =>
          action.sessions.some(
            (session) => session.terminal_id === tab.session.terminal_id,
          ),
        )
        .map((tab) => {
          const session = action.sessions.find(
            (next) => next.terminal_id === tab.session.terminal_id,
          );
          return session ? { ...tab, session, title: session.label } : tab;
        })
        .concat(added);
      return {
        groups: {
          ...state.groups,
          [action.scopeKey]: {
            ...current,
            tabs,
            activeTabId:
              current.activeTabId && tabs.some((tab) => tab.id === current.activeTabId)
                ? current.activeTabId
                : (tabs[tabs.length - 1]?.id ?? null),
            hydrated: true,
          },
        },
      };
    }
    case "add": {
      const current = state.groups[action.scopeKey] ?? EMPTY_GROUP;
      const tabs = current.tabs.some((tab) => tab.id === action.session.terminal_id)
        ? current.tabs
        : [...current.tabs, tabFromSession(action.session)];
      return updateGroup(state, action.scopeKey, {
        ...current,
        tabs,
        activeTabId: action.session.terminal_id,
        collapsed: false,
        hydrated: true,
      });
    }
    case "close": {
      const current = state.groups[action.scopeKey] ?? EMPTY_GROUP;
      const idx = current.tabs.findIndex((tab) => tab.id === action.terminalId);
      const tabs = current.tabs.filter((tab) => tab.id !== action.terminalId);
      const activeTabId =
        current.activeTabId === action.terminalId
          ? (tabs[Math.min(idx, tabs.length - 1)]?.id ?? null)
          : current.activeTabId;
      return updateGroup(state, action.scopeKey, {
        ...current,
        tabs,
        activeTabId,
        collapsed: tabs.length === 0 ? false : current.collapsed,
      });
    }
    case "select": {
      const current = state.groups[action.scopeKey] ?? EMPTY_GROUP;
      return updateGroup(state, action.scopeKey, {
        ...current,
        activeTabId: action.terminalId,
        collapsed: false,
      });
    }
    case "setCollapsed": {
      const current = state.groups[action.scopeKey] ?? EMPTY_GROUP;
      return updateGroup(state, action.scopeKey, {
        ...current,
        collapsed: action.collapsed,
      });
    }
    case "label":
      return mapTabs(state, (tab) =>
        tab.id === action.terminalId
          ? { ...tab, title: action.label, session: { ...tab.session, label: action.label } }
          : tab,
      );
    case "exited":
      return mapTabs(state, (tab) =>
        tab.id === action.terminalId
          ? { ...tab, session: { ...tab.session, exited: true } }
          : tab,
      );
  }
}

function updateGroup(
  state: State,
  key: string,
  group: TerminalGroupState,
): State {
  return { groups: { ...state.groups, [key]: group } };
}

function mapTabs(state: State, map: (tab: TerminalTab) => TerminalTab): State {
  return {
    groups: Object.fromEntries(
      Object.entries(state.groups).map(([key, group]) => [
        key,
        { ...group, tabs: group.tabs.map(map) },
      ]),
    ),
  };
}

function tabFromSession(session: TerminalSessionInfo): TerminalTab {
  return {
    id: session.terminal_id,
    title: session.label,
    session,
  };
}

function scopeKey(workspaceId: string, taskId: string): string {
  return `${workspaceId}:${taskId}`;
}
