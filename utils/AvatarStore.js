import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Config from "./ConfigHandler.js";
import { log, logError } from "./Logger.js";

/**
 * Where a bridged author's face is kept so Discord can read it.
 *
 * Discord's client loads a `cdn.discordapp.com` avatar directly and pulls
 * everything else through its image proxy, and the proxy cannot fetch a Gryt
 * upload: the read token lives in the query string and does not survive the
 * trip, so it gets a 401 instead of a picture. The way out is a URL with
 * nothing on the end of it, on a host that will simply hand over a PNG.
 *
 * So Grytcord writes the flattened still into its own data folder and serves
 * it. The folder is already a volume, which means two ways to publish it and
 * both are fine:
 *
 *  - point a web server that is already running at the folder (no port, no
 *    proxying, nginx `alias` and done), or
 *  - publish Grytcord's own port and let it serve them (see `HealthCheck.js`).
 *
 * Either way `PublicBaseUrl` is what turns it on: without somewhere public to
 * point at, a file on disk is no use to Discord, and Grytcord says so once
 * rather than pretending.
 *
 * The name is a digest of the server and file id, so it is stable: the same
 * face keeps the same URL across restarts, and messages bridged months ago go
 * on showing it.
 */

/** Names this module will write and serve. Anything else is not ours. */
const KEY_PATTERN = /^[a-f0-9]{40}$/;

/** Roughly 40KB each, so a few hundred is nothing. Oldest go first. */
const MAX_STORED = 1000;

/** @returns {string} */
export function avatarsDir() {
  return path.join(Config.DataFolderPath ?? "/data", "avatars");
}

/**
 * The stable name for one Gryt file on one server.
 *
 * @param {string} host
 * @param {string} fileId
 */
export function avatarKey(host, fileId) {
  return crypto.createHash("sha1").update(`${host}:${fileId}`).digest("hex");
}

/**
 * Where Discord should come to read it, or null when nothing has been
 * published for it to read.
 *
 * @param {string} key
 * @returns {string | null}
 */
export function publicAvatarUrl(key) {
  const base = String(Config.PublicBaseUrl ?? "").replace(/\/+$/, "");
  if (!base) return null;
  return `${base}/avatars/${key}.png`;
}

/**
 * @param {string} key
 * @param {Buffer} png
 * @returns {Promise<boolean>}
 */
export async function saveAvatar(key, png) {
  if (!KEY_PATTERN.test(key)) return false;
  try {
    const dir = avatarsDir();
    await fs.promises.mkdir(dir, { recursive: true });
    // Written beside and moved into place, so a half-written file is never
    // served to Discord — which would cache the broken read, not retry it.
    const target = path.join(dir, `${key}.png`);
    const temporary = `${target}.${process.pid}.tmp`;
    await fs.promises.writeFile(temporary, png);
    await fs.promises.rename(temporary, target);
    prune().catch(() => {});
    return true;
  } catch (e) {
    logError("AVATAR", `Could not write the avatar ${key} to ${avatarsDir()}.`, e);
    return false;
  }
}

/** @param {string} key */
export function hasAvatar(key) {
  if (!KEY_PATTERN.test(key)) return false;
  try {
    return fs.existsSync(path.join(avatarsDir(), `${key}.png`));
  } catch {
    return false;
  }
}

/**
 * One stored avatar, for the built-in server. The name is checked against the
 * pattern first: this reads a path built from something that arrived over the
 * network, and `..` is not a digest.
 *
 * @param {string} key
 * @returns {Promise<Buffer | null>}
 */
export async function readAvatar(key) {
  if (!KEY_PATTERN.test(key)) return null;
  try {
    return await fs.promises.readFile(path.join(avatarsDir(), `${key}.png`));
  } catch {
    return null;
  }
}

/** Keep the folder from growing without end. Oldest written go first. */
async function prune() {
  const dir = avatarsDir();
  const names = (await fs.promises.readdir(dir)).filter((x) => x.endsWith(".png"));
  if (names.length <= MAX_STORED) return;

  const withTimes = await Promise.all(
    names.map(async (name) => {
      const stat = await fs.promises.stat(path.join(dir, name)).catch(() => null);
      return { name, at: stat?.mtimeMs ?? 0 };
    }),
  );
  withTimes.sort((a, b) => a.at - b.at);

  const doomed = withTimes.slice(0, withTimes.length - MAX_STORED);
  for (const file of doomed) {
    await fs.promises.unlink(path.join(dir, file.name)).catch(() => {});
  }
  log("AVATAR", `Pruned ${doomed.length} old avatars from ${dir}.`);
}
