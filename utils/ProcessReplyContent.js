import truncate from "truncate";
import { sanitizeLinks } from "./EmojiStickerParser.js";
import { sanitizePings } from "./SanitizePings.js";

/**
 * The one line of context a reply shows above itself.
 *
 * @param {{ content?: string, attachments?: any[] } | null} message
 */
export async function processReplyContent(message) {
  if (!message) return "*Original message*";

  const content = (message.content ?? "").trim();
  if (content.length === 0) {
    // discord.js hands back a Collection, Gryt an array.
    const attachmentCount =
      message.attachments?.size ?? message.attachments?.length ?? 0;
    if (attachmentCount > 0) return "*Attachment*";
    if ((message.stickers?.size ?? 0) > 0) return "*Sticker*";
    return "*Empty message*";
  }

  const firstLine = content.split("\n")[0] ?? "";
  let processed = sanitizeLinks(truncate(sanitizePings(firstLine), 35));
  if (!processed.endsWith("…") && content.split("\n").length > 1) {
    processed += "…";
  }
  return processed;
}
