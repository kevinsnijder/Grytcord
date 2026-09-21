//@ts-check
import http from "node:http";
import Config from "./ConfigHandler.js";
import { log } from "./Logger.js";
import { readAvatar } from "./AvatarStore.js";

/**
 * @param {import("discord.js").Client} discordClient
 * @param {import("./GrytClient.js").GrytClient} grytClient
 * @returns {import("node:http").Server | null}
 */
export function setupHealthcheck(discordClient, grytClient) {
  if (Config.HealthcheckEnabled === false) return null;

  const port = Config.HealthcheckPort ?? 8080;
  const host = Config.HealthcheckHost ?? "0.0.0.0";

  const server = http.createServer((req, res) => {
    const url = (req.url || "/").split("?")[0];

    // Bridged authors' faces, for the Discord side to fetch. They are flat
    // files in the data folder and there is nothing private about them — they
    // are already on their way to being shown in a Discord channel — but the
    // name is checked against a digest pattern before it touches the disk.
    const avatar = /^\/avatars\/([a-f0-9]{40})\.png$/.exec(url);
    if (avatar && req.method === "GET") {
      serveAvatar(res, avatar[1] ?? "");
      return;
    }

    if (
      req.method !== "GET" ||
      (url !== "/health" && url !== "/live" && url !== "/ready")
    ) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "not_found" }));
      return;
    }

    const discordOnline = isDiscordOnline(discordClient);
    const grytServers = [...grytClient.servers.values()].map((x) => ({
      host: x.host,
      status: x.ready ? "online" : "offline",
    }));
    const grytOnline = grytClient.isReady();

    const healthy = url === "/live" ? true : discordOnline && grytOnline;

    res.writeHead(healthy ? 200 : 503, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: healthy ? "ok" : "degraded",
        discord: discordOnline ? "online" : "offline",
        gryt: grytServers,
        uptime: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
      }),
    );
  });

  server.on("error", (err) => {
    log("META", `Healthcheck server failed on ${host}:${port}:`, err);
  });

  server.listen(port, host, () => {
    log("META", `Healthcheck listening on ${host}:${port} (/health)`);
  });

  return server;
}

/**
 * @param {import("node:http").ServerResponse} res
 * @param {string} key
 */
async function serveAvatar(res, key) {
  const png = await readAvatar(key);
  if (!png) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "not_found" }));
    return;
  }

  // The name is a digest of immutable content, so it can be cached hard. That
  // matters: Discord's proxy will come back for this on every render.
  res.writeHead(200, {
    "Content-Type": "image/png",
    "Content-Length": png.byteLength,
    "Cache-Control": "public, max-age=604800, immutable",
  });
  res.end(png);
}

/** @param {import("discord.js").Client} client */
function isDiscordOnline(client) {
  try {
    if (typeof client.isReady === "function" && !client.isReady()) return false;
    const wsStatus = client.ws?.status;
    if (typeof wsStatus === "number" && wsStatus !== 0) return false;
    return !!client.user;
  } catch {
    return false;
  }
}
