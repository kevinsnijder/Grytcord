import Config from "../utils/ConfigHandler.js";

/**
 * Logging, and what it takes to see any.
 *
 * A category not in `LoggingCategories` is dropped, which is how the whole
 * per-message trace (`DEBUG`) stays out of the way on a normal day. Two rules
 * keep that from turning into a bot that fails in silence:
 *
 * - `ERROR` is never filtered. Something that went wrong is not a category.
 * - `GRYTCORD_LOG` in the environment beats the config file. A container
 *   mounting `config.js` read-only can still be told to talk:
 *   `-e GRYTCORD_LOG=ALL`, or `-e GRYTCORD_LOG=GRYT,DISCORD,AVATAR`.
 *
 * `ALL` (or `*`) turns everything on.
 */

/** Printed whatever the configuration says. */
const ALWAYS = new Set(["ERROR"]);

/** @type {Set<string> | null} */
let enabled = null;
let everything = false;

/** @param {unknown} value */
function toCategories(value) {
  if (typeof value === "string") {
    return value
      .split(",")
      .map((x) => x.trim().toUpperCase())
      .filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value.map((x) => String(x).trim().toUpperCase()).filter(Boolean);
  }
  return [];
}

function categories() {
  if (enabled) return enabled;

  const fromEnv = toCategories(process.env.GRYTCORD_LOG);
  const configured = fromEnv.length > 0 ? fromEnv : toCategories(Config.LoggingCategories);

  everything = configured.includes("ALL") || configured.includes("*");
  enabled = new Set(configured);
  return enabled;
}

/** Which categories are live, and where that was decided. */
export function loggingSummary() {
  const live = [...categories()];
  const source = toCategories(process.env.GRYTCORD_LOG).length > 0
    ? "GRYTCORD_LOG"
    : "config.js";
  return {
    source,
    categories: everything ? ["ALL"] : live,
  };
}

/**
 * Whether a category would print. Worth checking before building an expensive
 * line — dumping an object costs the same whether or not anybody sees it.
 *
 * @param {string} type
 */
export function logEnabled(type) {
  const upper = String(type).toUpperCase();
  return ALWAYS.has(upper) || everything || categories().has(upper);
}

function stamp() {
  return new Date().toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * @param {string} type
 * @param {...any} msg
 */
export function log(type, ...msg) {
  const upper = String(type).toUpperCase();
  if (!logEnabled(upper)) return;
  console.log(`[${stamp()} ${upper}]`, ...msg);
}

/**
 * Something went wrong. Always printed, and always with the stack — a bare
 * `Error: fetch failed` names no line in this repo, so the stack is the whole
 * message.
 *
 * @param {string} scope where it went wrong, e.g. "GRYT" or "AVATAR"
 * @param {string} message
 * @param {unknown} [error]
 */
export function logError(scope, message, error) {
  const detail =
    error instanceof Error
      ? (error.stack ?? `${error.name}: ${error.message}`)
      : error !== undefined
        ? String(error)
        : "";
  console.error(`[${stamp()} ERROR ${String(scope).toUpperCase()}]`, message, ...(detail ? ["\n" + detail] : []));
}

/**
 * Said once at startup, past the filter, because it is the map to everything
 * else: somebody staring at an empty log needs to know the log is switched off
 * rather than the bot idle.
 */
export function announceLogging() {
  const { source, categories: live } = loggingSummary();
  console.log(
    `[${stamp()} META] Logging ${live.join(", ") || "(nothing)"} from ${source}.` +
      ` Set GRYTCORD_LOG=ALL on the container for everything, or a comma-separated list` +
      ` (GRYT, DISCORD, DB, META, DEBUG, AVATAR). ERROR is always shown.`,
  );
}
