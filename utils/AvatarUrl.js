import ExpiryMap from "expiry-map";
import { log, logError } from "./Logger.js";
import {
  avatarKey,
  avatarsDir,
  hasAvatar,
  publicAvatarUrl,
  saveAvatar,
} from "./AvatarStore.js";

/**
 * The picture a bridged Gryt message wears on Discord.
 *
 * A webhook message's face comes from `avatar_url`, and Discord loads it two
 * different ways: a `cdn.discordapp.com` URL is fetched by the client
 * directly, and anything else goes through Discord's image proxy. A picture on
 * a Gryt server is "anything else", and the proxy never comes back with it —
 * the file endpoint wants its read token in the query string, and what the
 * proxy asks for gets a 401 instead of an image. Nothing reports this. The
 * message simply arrives wearing the bridge webhook's blank face.
 *
 * Measured by posting through one webhook six times, changing one thing each
 * time and looking at which messages ended up with a face:
 *
 *     2. cdn.discordapp.com png, no query      -> shows
 *     3. cdn.discordapp.com png, with query    -> shows
 *     4. flattened still on the Gryt host      -> nothing
 *     5. the raw Gryt upload                   -> nothing
 *     6. the same still on cdn.discordapp.com  -> shows
 *
 * So the query string is not the problem and the format is not the problem:
 * the token-gated Gryt URL is. `author.avatar` on the message Discord hands
 * back is null in every one of those cases, including the three that work, so
 * it says nothing about whether a picture arrived — do not read it as a
 * verdict.
 *
 * What Discord needs is a plain URL that answers with an image and asks for
 * nothing. So: decode the Gryt file, flatten it to a still PNG (an avatar may
 * be an animated GIF, and this server's `?thumb=1` answers in AVIF), write it
 * into Grytcord's own data folder, and hand Discord the URL it is published
 * at. `utils/AvatarStore.js` owns the folder and the publishing; this file
 * owns deciding and converting.
 *
 * The file on disk is the cache, named after the Gryt file id, so a restart
 * finds the same face already there and messages bridged long ago keep theirs.
 */

/** Re-checked hourly, in case the folder was cleared underneath us. */
const STORED_TTL = 60 * 60 * 1000;

/** Source file id -> the URL its still is published at. @type {ExpiryMap<string, string>} */
const stored = new ExpiryMap(STORED_TTL);

/** Lookups happening right now, so a burst of messages costs one. @type {Map<string, Promise<string | null>>} */
const inFlight = new Map();

/** Things already complained about, so the same sentence is said once. @type {ExpiryMap<string, true>} */
const warned = new ExpiryMap(STORED_TTL);

/** Discord draws an avatar at 128px. Serving anything bigger is waste. */
const AVATAR_EDGE = 128;

/** How much of a source picture is worth downloading to flatten it. */
const SOURCE_LIMIT = 16_000_000;

/**
 * A file URL with its read token blotted out.
 *
 * The token is a credential: anybody holding it can read the server's uploads
 * for the next twelve hours. It does not belong in a log somebody will paste
 * into a chat to ask for help.
 *
 * @param {string | null} url
 */
export function redactFileUrl(url) {
  if (!url) return String(url);
  return url.replace(/([?&]t=)[^&]+/, "$1***");
}

/**
 * What the first bytes say the file is, for the log. The content type is the
 * server's opinion; this is the file's.
 *
 * @param {Buffer} buffer
 */
function describeMagic(buffer) {
  if (buffer.length < 4) return "(empty)";
  const magic = buffer.subarray(0, 4).toString("latin1");
  if (magic === "GIF8") return "gif";
  if (magic === "RIFF") return "webp";
  if (magic.slice(1) === "PNG") return "png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return "jpeg";
  if (buffer.subarray(4, 8).toString("latin1") === "ftyp") {
    return buffer.subarray(8, 12).toString("latin1").startsWith("avif")
      ? "avif"
      : "isobmff";
  }
  return `unknown(${[...buffer.subarray(0, 4)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ")})`;
}

/** @type {any} */
let sharpModule;
let sharpTried = false;

/**
 * The image library, if it is there.
 *
 * Loaded on demand and never fatal: a Grytcord whose `sharp` failed to install
 * should bridge messages with blank faces, not refuse to start.
 */
async function loadSharp() {
  if (sharpTried) return sharpModule ?? null;
  sharpTried = true;
  try {
    sharpModule = (await import("sharp")).default;
  } catch (e) {
    sharpModule = null;
    logError(
      "AVATAR",
      "sharp is not available, so Gryt avatars cannot be flattened for Discord. Run `pnpm install` and rebuild the image.",
      e,
    );
  }
  return sharpModule;
}

/**
 * The whole file, up to a limit. `peek` reads a header; this is for the bytes
 * that are going to be decoded.
 *
 * @param {string} url
 * @param {number} limit
 * @returns {Promise<Buffer | null>}
 */
async function downloadFile(url, limit) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) {
      log(
        "AVATAR",
        `${redactFileUrl(url)} -> ${res.status} ${res.statusText}` +
          (res.status === 401 || res.status === 403
            ? " (a file-token problem: nothing can read this)"
            : ""),
      );
      return null;
    }
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > limit) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    return bytes.byteLength > limit ? null : bytes;
  } catch (e) {
    logError("AVATAR", `Could not download ${redactFileUrl(url)}.`, e);
    return null;
  }
}

/**
 * One small still PNG from whatever was handed in — the first frame of an
 * animation, or a picture in a format Discord will not read.
 *
 * @param {Buffer} bytes
 * @returns {Promise<Buffer | null>}
 */
async function toStillPng(bytes) {
  const sharp = await loadSharp();
  if (!sharp) return null;

  try {
    return await sharp(bytes, { animated: false })
      .resize(AVATAR_EDGE, AVATAR_EDGE, { fit: "cover" })
      .png()
      .toBuffer();
  } catch (e) {
    logError("AVATAR", "Could not decode the avatar to flatten it.", e);
    return null;
  }
}

/**
 * Flatten the Gryt picture and publish it, giving back the URL Discord should
 * read it from.
 *
 * @param {import("./GrytClient.js").GrytServerConnection} server
 * @param {string} fileId
 * @returns {Promise<string | null>}
 */
async function publishStill(server, fileId) {
  const key = avatarKey(server.host, fileId);
  const url = publicAvatarUrl(key);

  if (!url) {
    // Nowhere to publish to. Said once, with the thing to do about it, rather
    // than converting a picture nobody will ever be able to read.
    if (!warned.has("no-base-url")) {
      warned.set("no-base-url", true);
      log(
        "GRYT",
        "PublicBaseUrl is not set, so bridged messages cannot show their author's picture: " +
          "Discord will not read an avatar from the Gryt server itself. Point a URL at " +
          `${avatarsDir()} (nginx alias, or publish Grytcord's own port) and set PublicBaseUrl to it.`,
      );
    }
    return null;
  }

  // Already converted, possibly by a previous run of the process.
  if (hasAvatar(key)) return url;

  // The thumbnail first: a couple of kilobytes to decode instead of a couple
  // of megabytes, when the server has one and sharp can read it.
  const sources = [
    server.fileUrl(fileId, { thumb: true }),
    server.fileUrl(fileId),
  ];

  for (const source of sources) {
    const bytes = await downloadFile(source, SOURCE_LIMIT);
    if (!bytes) continue;

    const png = await toStillPng(bytes);
    if (!png) continue;

    if (!(await saveAvatar(key, png))) return null;
    log(
      "AVATAR",
      `${fileId}: ${bytes.byteLength} bytes of ${describeMagic(bytes)} -> ` +
        `${png.byteLength}-byte png published at ${url}`,
    );
    return url;
  }

  return null;
}

/**
 * The URL to hand Discord as a webhook `avatar_url`, or null when the member
 * has no picture.
 *
 * @param {import("./GrytMessage.js").GrytMessage} message
 * @returns {Promise<string | null>}
 */
export async function bridgeAvatarURL(message) {
  const fileId = message.avatarFileId;
  if (!fileId) {
    // The commonest reason a picture "does not sync" is that there was never
    // one to send: the message carried no file id and the member list had none
    // either. Those two are different bugs and the log has to tell them apart,
    // so it says what each one actually held.
    //
    // Wrapped, because a line that explains a missing picture must not be the
    // thing that stops the message.
    try {
      const member = message.member;
      log(
        "AVATAR",
        `no picture for ${message.senderId} on ${message.host}: ` +
          `sender_avatar_file_id=${JSON.stringify(message.raw?.sender_avatar_file_id ?? null)}, ` +
          (member
            ? `member fields=[${Object.keys(member).join(", ")}]`
            : `no member entry (the member list holds ${message.server?.members?.size ?? 0})`),
      );
    } catch {}
    return null;
  }

  const server = message.server;
  const key = `${server.host}:${fileId}`;

  const already = stored.get(key);
  if (already) return already;

  // A busy channel is several messages from the same person at once, and one
  // of them doing the work is enough.
  let pending = inFlight.get(key);
  if (!pending) {
    pending = publishStill(server, fileId)
      .catch((e) => {
        logError("AVATAR", `Could not work out how to send the avatar ${fileId}.`, e);
        return null;
      })
      .then((url) => {
        if (url) stored.set(key, url);
        inFlight.delete(key);
        return url;
      });
    inFlight.set(key, pending);
  }

  const url = await pending;
  if (url) return url;

  // Nothing could be published. The Gryt URL is unlikely to draw — that is the
  // whole reason this exists — but it costs nothing to send and it is what
  // every version before this one sent.
  if (!warned.has(server.host)) {
    warned.set(server.host, true);
    log(
      "GRYT",
      `Could not publish ${server.host}'s avatars, so bridged messages will probably show a blank face. The AVATAR log says why.`,
    );
  }
  return server.fileUrl(fileId);
}
