import { EmbedBuilder as DiscordEmbedBuilder } from "discord.js";

/**
 * Discord embeds and Gryt cards are close cousins, which is most of why the
 * webhook half of the bridge looks right. The limits differ though, and a card
 * over one of them is refused outright rather than trimmed, so everything is
 * cut to size here.
 */
export const CARD_LIMITS = {
  cards: 10,
  title: 256,
  description: 4000,
  authorName: 256,
  fields: 25,
  fieldName: 256,
  fieldValue: 1024,
  footerText: 2048,
  /** Across every card in one message. */
  total: 6000,
};

/** @param {string | null | undefined} value @param {number} max */
function cut(value, max) {
  if (!value) return undefined;
  const text = String(value).trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Only http(s) URLs get through Gryt's schema, and only those are worth sending. */
function httpUrl(value) {
  if (!value) return undefined;
  const url = String(value);
  return /^https?:\/\//i.test(url) && url.length <= 2048 ? url : undefined;
}

/** Gryt takes `#rrggbb` or an integer; Discord gives an integer. */
function toCardColor(color) {
  if (typeof color === "number" && Number.isFinite(color)) {
    return Math.max(0, Math.min(0xffffff, Math.round(color)));
  }
  if (typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color)) return color;
  return undefined;
}

/**
 * One Discord embed as a Gryt card.
 *
 * @param {import("discord.js").Embed | any} embed
 */
export function discordEmbedToCard(embed) {
  if (!embed) return null;

  /** @type {any} */
  const card = {};

  const title = cut(embed.title, CARD_LIMITS.title);
  if (title) card.title = title;

  const url = httpUrl(embed.url);
  if (url && title) card.url = url;

  const description = cut(embed.description, CARD_LIMITS.description);
  if (description) card.description = description;

  const color = toCardColor(embed.color);
  if (color !== undefined) card.color = color;

  if (embed.author?.name) {
    card.author = {
      name: cut(embed.author.name, CARD_LIMITS.authorName),
      ...(httpUrl(embed.author.url) ? { url: httpUrl(embed.author.url) } : {}),
      ...(httpUrl(embed.author.iconURL ?? embed.author.icon_url)
        ? { icon_url: httpUrl(embed.author.iconURL ?? embed.author.icon_url) }
        : {}),
    };
  }

  const fields = (embed.fields ?? [])
    .slice(0, CARD_LIMITS.fields)
    .map((field) => ({
      name: cut(field.name, CARD_LIMITS.fieldName) ?? "​",
      value: cut(field.value, CARD_LIMITS.fieldValue) ?? "​",
      inline: Boolean(field.inline),
    }));
  if (fields.length > 0) card.fields = fields;

  const image = httpUrl(embed.image?.url);
  if (image) card.image_url = image;

  const thumbnail = httpUrl(embed.thumbnail?.url);
  if (thumbnail) card.thumbnail_url = thumbnail;

  if (embed.footer?.text) {
    card.footer = {
      text: cut(embed.footer.text, CARD_LIMITS.footerText),
      ...(httpUrl(embed.footer.iconURL ?? embed.footer.icon_url)
        ? { icon_url: httpUrl(embed.footer.iconURL ?? embed.footer.icon_url) }
        : {}),
    };
  }

  if (embed.timestamp) {
    const stamp = new Date(embed.timestamp);
    if (!Number.isNaN(stamp.getTime())) card.timestamp = stamp.toISOString();
  }

  // A card with none of these is refused with `empty_card`.
  const hasContent =
    card.title || card.description || card.fields || card.image_url || card.author;
  return hasContent ? card : null;
}

/** How much of the 6000-character budget one card spends. */
function cardTextLength(card) {
  let total = 0;
  total += card.title?.length ?? 0;
  total += card.description?.length ?? 0;
  total += card.author?.name?.length ?? 0;
  total += card.footer?.text?.length ?? 0;
  for (const field of card.fields ?? []) {
    total += (field.name?.length ?? 0) + (field.value?.length ?? 0);
  }
  return total;
}

/**
 * Every Discord embed on a message, as cards a webhook will accept: at most ten
 * of them, and dropped from the end once they no longer fit the shared budget.
 *
 * @param {Array<any>} embeds
 */
export function discordEmbedsToCards(embeds) {
  const cards = [];
  let budget = CARD_LIMITS.total;

  for (const embed of embeds ?? []) {
    if (cards.length >= CARD_LIMITS.cards) break;
    const card = discordEmbedToCard(embed);
    if (!card) continue;
    const cost = cardTextLength(card);
    if (cost > budget) continue;
    budget -= cost;
    cards.push(card);
  }

  return cards;
}

/**
 * An image attachment as a card, so a picture from Discord still shows as a
 * picture on Gryt when the message goes through a webhook. Gryt downloads it
 * once and keeps its own copy, so the Discord link expiring changes nothing.
 *
 * @param {{ name: string, url: string, spoiler?: boolean }} attachment
 */
export function attachmentToCard(attachment) {
  const url = httpUrl(attachment.url);
  if (!url) return null;
  return {
    ...(attachment.spoiler ? { title: `⚠️ ${cut(attachment.name, CARD_LIMITS.title)}` } : {}),
    image_url: url,
  };
}

/**
 * A card drawn as text.
 *
 * `chat:send` has no cards — they belong to webhooks — so anything the bot
 * posts itself says what the card said instead of dropping it.
 *
 * @param {Array<any>} cards
 */
export function cardsToText(cards) {
  const parts = [];

  for (const card of cards ?? []) {
    if (!card) continue;
    const lines = [];

    if (card.author?.name) lines.push(`**${card.author.name}**`);
    if (card.title) {
      lines.push(card.url ? `**[${card.title}](${card.url})**` : `**${card.title}**`);
    }
    if (card.description) lines.push(card.description);

    for (const field of card.fields ?? []) {
      lines.push(`**${field.name}**: ${field.value}`);
    }

    if (card.image_url) lines.push(card.image_url);
    if (card.thumbnail_url && !card.image_url) lines.push(card.thumbnail_url);
    if (card.footer?.text) lines.push(`-# ${card.footer.text}`);

    if (lines.length > 0) parts.push(lines.join("\n"));
  }

  return parts.join("\n\n");
}

/**
 * A Gryt card as a Discord embed, for the other direction.
 *
 * @param {any} card
 * @returns {DiscordEmbedBuilder | null}
 */
export function cardToDiscordEmbed(card) {
  if (!card) return null;

  const embed = new DiscordEmbedBuilder();
  let empty = true;

  if (card.title) {
    embed.setTitle(cut(card.title, CARD_LIMITS.title) ?? null);
    empty = false;
  }
  if (card.url && card.title) embed.setURL(httpUrl(card.url) ?? null);
  if (card.description) {
    embed.setDescription(cut(card.description, CARD_LIMITS.description) ?? null);
    empty = false;
  }

  if (typeof card.color === "number") {
    embed.setColor(card.color);
  } else if (typeof card.color === "string" && /^#[0-9a-f]{6}$/i.test(card.color)) {
    embed.setColor(Number.parseInt(card.color.slice(1), 16));
  }

  if (card.author?.name) {
    embed.setAuthor({
      name: cut(card.author.name, CARD_LIMITS.authorName) ?? "​",
      ...(httpUrl(card.author.url) ? { url: httpUrl(card.author.url) } : {}),
      ...(httpUrl(card.author.icon_url)
        ? { iconURL: httpUrl(card.author.icon_url) }
        : {}),
    });
    empty = false;
  }

  const fields = (card.fields ?? []).slice(0, CARD_LIMITS.fields).map((field) => ({
    name: cut(field.name, CARD_LIMITS.fieldName) ?? "​",
    value: cut(field.value, CARD_LIMITS.fieldValue) ?? "​",
    inline: Boolean(field.inline),
  }));
  if (fields.length > 0) {
    embed.addFields(...fields);
    empty = false;
  }

  if (httpUrl(card.image_url)) {
    embed.setImage(httpUrl(card.image_url));
    empty = false;
  }
  if (httpUrl(card.thumbnail_url)) embed.setThumbnail(httpUrl(card.thumbnail_url));

  if (card.footer?.text) {
    embed.setFooter({
      text: cut(card.footer.text, CARD_LIMITS.footerText) ?? "​",
      ...(httpUrl(card.footer.icon_url)
        ? { iconURL: httpUrl(card.footer.icon_url) }
        : {}),
    });
  }

  if (card.timestamp) {
    const stamp = new Date(card.timestamp);
    if (!Number.isNaN(stamp.getTime())) embed.setTimestamp(stamp);
  }

  return empty ? null : embed;
}

/**
 * Every card on a Gryt message as Discord embeds.
 *
 * @param {Array<any>} cards
 */
export function cardsToDiscordEmbeds(cards) {
  return (cards ?? [])
    .slice(0, CARD_LIMITS.cards)
    .map((card) => cardToDiscordEmbed(card))
    .filter(Boolean);
}
