/**
 * Adding the bot is one link on Discord and an approval on Gryt: a Gryt bot
 * knocks on its own and an admin lets it in, so there is nothing to click.
 */

/** @param {string} clientId */
export function discordAuthLink(clientId) {
  return `https://discord.com/oauth2/authorize?client_id=${clientId}&permissions=1632445911616&integration_type=0&scope=bot+applications.commands`;
}

/** @param {string} host */
export function grytJoinHint(host) {
  return `Open ${host} in Gryt, go to Server settings > Bots and approve Grytcord.`;
}

/** @param {string[]} lines */
export function renderBox(lines) {
  const width = Math.max(...lines.map((l) => l.length));
  const top = `┏━${"━".repeat(width)}━┓`;
  const bottom = `┗━${"━".repeat(width)}━┛`;
  const middle = lines.map((l) => `┃ ${l.padEnd(width)} ┃`);
  [top, ...middle, bottom].forEach((x) => console.log(x));
}
