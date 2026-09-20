/**
 * "bridging N channels" is read from the database, so it is only right when
 * something re-reads it. Bridging commands call `refreshPresence` rather than
 * importing index.js, which would be a cycle.
 */

/** @type {null | (() => void | Promise<void>)} */
let updater = null;

/** @param {() => void | Promise<void>} fn */
export function setPresenceUpdater(fn) {
  updater = fn;
}

/** Fire and forget: a stale status line is never worth failing a command over. */
export function refreshPresence() {
  try {
    const result = updater?.();
    if (result && typeof result.catch === "function") result.catch(() => {});
  } catch {}
}
