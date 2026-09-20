import pkg from "../package.json" with { type: "json" };

export function buildDiscordUserAgentSuffix() {
  return `Grytcord/${pkg.version}`;
}

export function buildExtHttpUserAgent() {
  return `Grytcord/${pkg.version}`;
}
