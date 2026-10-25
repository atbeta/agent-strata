/**
 * The name this build calls itself.
 *
 * Every surface that states the product — the caption bar, the window title,
 * the About panel, the diagnostics header — reads it from here, so a rename is
 * one edit instead of a hunt through copy that has to be rediscovered by grep
 * and that nobody remembers to update.
 *
 * `src-tauri/tauri.conf.json` is the packaged side of the same name: it is
 * what the installer lists and what the shell titles its window with.
 * `app-name.test.ts` holds this constant to it, so the two cannot drift apart
 * without a failing test saying so.
 */
export const APP_NAME = "Agent Strata";
