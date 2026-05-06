import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

/**
 * Check the configured updater endpoint once per app start. If a newer release
 * is available, prompt the user; on accept, download → install → relaunch.
 *
 * Skipped in `tauri dev` (no release server to talk to). Failures are logged
 * but never throw — being offline or unreachable shouldn't break startup.
 */
export async function checkForUpdatesOnStartup() {
  if (import.meta.env.DEV) return;
  try {
    const update = await check();
    if (!update) return;
    const ok = window.confirm(
      `A new version of Orca (${update.version}) is available.\n\n` +
        (update.body ? `${update.body}\n\n` : "") +
        `Download and install now? The app will restart.`,
    );
    if (!ok) return;
    await update.downloadAndInstall();
    await relaunch();
  } catch (err) {
    console.warn("auto-update check failed:", err);
  }
}
