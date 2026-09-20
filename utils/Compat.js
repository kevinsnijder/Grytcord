import { AttachmentBuilder } from "discord.js";
import { GrytMessage, sendToGryt } from "./GrytMessage.js";
import { cardToDiscordEmbed } from "./EmbedConverter.js";

/**
 * Commands run on both sides, so they speak one payload shape:
 *
 *   { content?, embeds?: card[], files?: [{ name, data }] }
 *
 * where a "card" is the Gryt shape (`title`, `description`, `fields`, …).
 * This file turns that into whatever the side it landed on wants.
 */

/** @param {any} message */
export function isGryt(message) {
  return message instanceof GrytMessage;
}

/** @param {any} payload */
function toDiscordPayload(payload) {
  const normalized = typeof payload === "string" ? { content: payload } : payload ?? {};
  /** @type {any} */
  const out = {};

  // An empty string is how a caller clears the text of something it already
  // posted, so it is not the same as leaving `content` out.
  if (normalized.content !== undefined) out.content = normalized.content;

  const embeds = (normalized.embeds ?? [])
    .map((card) => cardToDiscordEmbed(card))
    .filter(Boolean);
  if (embeds.length > 0) out.embeds = embeds;

  if (normalized.files?.length) {
    out.files = normalized.files.map((file) =>
      new AttachmentBuilder(file.data).setName(file.name),
    );
  }

  if (normalized.allowedMentions) out.allowedMentions = normalized.allowedMentions;

  return out;
}

/**
 * Reply to whichever kind of message this is.
 *
 * @param {any} message
 * @param {string | { content?: string, embeds?: any[], files?: { name: string, data: Buffer }[] }} payload
 */
export async function replyTo(message, payload) {
  if (isGryt(message)) return message.reply(payload);
  return message.reply(toDiscordPayload(payload));
}

/**
 * Say a bridge worked without putting a message in a Discord channel.
 *
 * A reply is still a message everybody in the channel sees, so on Discord this
 * marks the command itself instead. Reacting can be refused (no Add Reactions),
 * and silence would then look like nothing happened — so that case falls back
 * to a reply rather than leaving somebody guessing.
 *
 * @param {any} message
 * @param {string} text
 */
export async function confirmQuietly(message, text) {
  if (isGryt(message)) return replyTo(message, text);

  try {
    await message.react("✅");
    return null;
  } catch {
    return replyTo(message, text);
  }
}

/**
 * Post into a channel on either side.
 *
 * @param {{ platform: "gryt", server: any, channelId: string } | { platform: "discord", channel: any }} target
 * @param {string | { content?: string, embeds?: any[], files?: { name: string, data: Buffer }[] }} payload
 */
export async function sendTo(target, payload) {
  if (target.platform === "gryt") {
    return sendToGryt(target.server, target.channelId, payload);
  }
  if (!target.channel?.isSendable?.()) return null;
  return target.channel.send(toDiscordPayload(payload));
}

/**
 * Edit a message this bot posted, on either side.
 *
 * @param {any} sent
 * @param {string | { content?: string, embeds?: any[] }} payload
 */
export async function editSent(sent, payload) {
  if (typeof sent?.edit !== "function") return;
  try {
    // The Gryt send result takes our payload shape; discord.js wants its own.
    return await sent.edit(
      sent.platform === "gryt" ? payload : toDiscordPayload(payload),
    );
  } catch {
    // An edit that fails is a cosmetic loss, never a reason to stop.
  }
}

export { toDiscordPayload };
