import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

export type ThemeMode = "light" | "dark";

type ThemeContextValue = {
  mode: ThemeMode;
};

const ThemeContext = createContext<ThemeContextValue>({ mode: "dark" });

const MEDIA_QUERY = "(prefers-color-scheme: dark)";

function readSystemMode(): ThemeMode {
  if (typeof window === "undefined") return "dark";
  return window.matchMedia(MEDIA_QUERY).matches ? "dark" : "light";
}

function applyMode(mode: ThemeMode) {
  const cl = document.documentElement.classList;
  cl.toggle("dark", mode === "dark");
  cl.toggle("light", mode === "light");
  document.documentElement.dataset.theme = mode;
  document.documentElement.style.colorScheme = mode;
}

/**
 * System-preference theme follower. The initial class is applied by the
 * inline bootstrap script in index.html (so we don't paint with the wrong
 * palette before React mounts); this provider keeps the class in sync after
 * mount and notifies subscribers when the OS preference flips.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<ThemeMode>(readSystemMode);

  useEffect(() => {
    applyMode(mode);
  }, [mode]);

  useEffect(() => {
    const mql = window.matchMedia(MEDIA_QUERY);
    const onChange = (e: MediaQueryListEvent) => {
      setMode(e.matches ? "dark" : "light");
    };
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return (
    <ThemeContext.Provider value={{ mode }}>{children}</ThemeContext.Provider>
  );
}

export function useThemeMode(): ThemeMode {
  return useContext(ThemeContext).mode;
}
