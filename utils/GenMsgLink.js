import { isGryt } from "./Compat.js";

/**
 * Somewhere to point at when reporting an error.
 *
 * Discord has a canonical message URL. Gryt does not — its clients are apps
 * rather than pages — so the honest answer there is where it was, not a link.
 *
 * @param {any} message
 */
export async function genMsgLink(message) {
  if (isGryt(message)) {
    return `${message.host} #${message.channelName} (${message.id})`;
  }
  return `https://discord.com/channels/${message.guildId}/${message.channelId}/${message.id}`;
}
