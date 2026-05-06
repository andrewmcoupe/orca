import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { router } from "./router";
import { checkForUpdatesOnStartup } from "./auto-update";
import { ThemeProvider } from "./lib/theme";
import "./App.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: Infinity,
      refetchOnWindowFocus: false,
    },
  },
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ThemeProvider>
  </React.StrictMode>,
);

// Fire-and-forget after the UI mounts. A short delay keeps the network call
// off the hot path so the window paints first and the prompt (if any) feels
// like an opt-in rather than a startup blocker.
window.setTimeout(() => {
  void checkForUpdatesOnStartup();
}, 2000);
