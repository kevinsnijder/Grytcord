## ⚠️ AI DISCLAIMER: This project is a 100% vibecoded migration from the original source. Do not trust any code in this repository without checking it yourself.

# Grytcord

A set-and-forget Discord <-> [Gryt](https://gryt.chat) bridge, ported from Fluxcord.

## Features

- Message bridging, both ways
- Attachment bridging (real uploads, both ways)
- Embed bridging (Discord embeds <-> Gryt cards)
- Reply bridging
- Edit bridging (where the platform allows it — see below)
- Delete bridging, including Discord bulk deletes and Gryt user purges
- Reaction bridging
- Custom emoji bridging, uploading the image to the other side when it is missing
- Typing indicators
- Mentions, resolved to the other side's member where a name matches
- One bot, many Gryt servers and many Discord guilds
- ℹ️ on a bridged message to get its origin in a DM
- Per-server prefix, error-logging channel and error reaction
- SQLite (optionally SQLCipher-encrypted) or PostgreSQL

## How a message crosses

Gryt gives a bot two ways to post, and Grytcord picks per message:

| | Webhook | The bot itself |
|---|---|---|
| Author's name and picture | yes | no — the name is the first line |
| Embeds (cards) | yes | drawn as text |
| File attachments | no | yes |
| Replies | quote line | real Gryt reply |
| Editable afterwards | no | yes |

**A Discord message with files is posted by the bot; everything else goes
through the channel's webhook.** That keeps the author's face on nearly every
message while still carrying files that would otherwise be dropped.

Which route a message took is stored on its row, so the edit and delete
handlers know what they are allowed to do with it.

## Known limits

These are Gryt's, not the bridge's:

- **Pins do not bridge.** Gryt has no pinned messages.
- **Edits of webhook-posted messages do not bridge.** `chat:edit` is
  own-messages-only, and a webhook message is not the bot's. The Gryt copy keeps
  the text it was posted with. Messages the bot posted itself (those with files)
  edit normally.
- **No voice bridging.** Deliberately left out of this port.
- **Reactions collapse.** Both sides react as the bot, so five people reacting
  with 🎉 arrive as one 🎉.

One of the bridge's own, worth knowing before you wonder about it:

- **Author pictures need somewhere public to live.** Discord will not fetch one
  from the Gryt server, so Grytcord republishes it. Without `PublicBaseUrl`,
  bridged messages have blank faces. See [Author pictures](#3b-author-pictures).

## Setting up

### 1. Discord

Create an application, add a bot, and enable the **Message Content Intent**.
Grytcord prints its own invite link on startup.

### 2. Gryt

Nothing to configure in advance. The bot knocks on first launch and waits; an
admin opens **Server settings > Bots**, reviews what it asked for, and lets it
in. The approval arrives without a restart.

For an unattended first launch, an admin can write the registration in advance
and put the single-use token in `GrytServers[].botToken`.

The permissions it asks for are listed, with why, in `utils/GrytClient.js`.

### 3. Config

```bash
cp config.example.js config.js
```

Fill in `DiscordBotToken`, `DiscordClientId`, `GrytServers` and
`AdminAccountIds`.

### 3b. Author pictures

Messages bridge fine without this — they just arrive with a blank face where
the author's picture should be. If you want the pictures, read on.

**Discord will not fetch an avatar from the Gryt server.** A webhook's
`avatar_url` is loaded by the Discord client, and anything that is not a
`cdn.discordapp.com` URL goes through Discord's image proxy, which cannot get
past the read token in a Gryt file URL. It gets a 401 and shows nothing. No
error appears anywhere — not in Grytcord's log, not in Discord's API response.

So Grytcord flattens each face to a small PNG and writes it to **`/data/avatars`
inside the container**. Your job is to give that folder a public URL and put it
in `PublicBaseUrl`. Two ways:

#### Option A: a web server you already run (no port to open)

Mount the folder your site already serves onto `/data/avatars`, so Grytcord
writes straight into it:

```
--volume /var/www/example.com/files/gryt/avatars:/data/avatars
```

in compose:

```yaml
volumes:
  - "./data:/data"
  - "/var/www/example.com/files/gryt/avatars:/data/avatars"
```

Keep your existing `/data` mount as well — this one nests inside it, and the
bot's identity and database stay where they are.

If the folder is not already under a served path, point the web server at it:

```nginx
location /gryt/avatars/ {
  alias /var/www/example.com/files/gryt/avatars/;
}
```

#### Option B: let Grytcord serve them

Publish its port (`-p 8080:8080`, or uncomment `ports` in the compose file) and
put a hostname in front of it. It serves `/avatars/<name>.png` alongside
`/health`.

#### Setting PublicBaseUrl

**Grytcord appends `/avatars/<name>.png` to it**, so set it to the URL of the
folder's *parent*:

| Pictures are served at | PublicBaseUrl |
|---|---|
| `https://example.com/files/gryt/avatars/x.png` | `https://example.com/files/gryt` |
| `https://grytcord.example.com/avatars/x.png` | `https://grytcord.example.com` |

It must be the hostname that actually serves the files. A host that redirects
somewhere else will not work: Discord follows the redirect and gets whatever is
at the other end, which is not your PNG. Check before you trust it:

```bash
curl -sI https://example.com/files/gryt/avatars/ | head -1
```

A `403` (directory listing off) or `404` is fine — both mean you reached the
right server. A `301`/`302` means you have the wrong name.

#### Checking it works

Post a message from Gryt, then look in the log:

```
[AVATAR] <file id>: 2290 bytes of avif -> 37812-byte png published at https://example.com/files/gryt/avatars/<name>.png
```

Open that URL. If it gives you a PNG, Discord will get the same thing. If the
log says `PublicBaseUrl is not set` or the file is missing from the folder, the
mount is wrong — `docker exec grytcord ls /data/avatars` should show the same
files as the host folder.

### 4. Run

```bash
docker compose up -d
```

or, without Docker:

```bash
pnpm install
pnpm run migrate
pnpm start
```

> **Keep `data/gryt-bot-identity.json`.** The key file *is* the bot: with it the
> bot keeps its id, name, role and history across restarts. Without it the
> server sees a stranger knocking, holding nothing. The compose file mounts
> `./data` for exactly this reason.

## Bridging two channels

In the Discord channel:

```
gc!setup
```

It replies with a code. Run that code in the Gryt channel:

```
gc!setup AbCdEf
```

Both channels are now bridged. `gc!setup both|d2g|g2d` picks a direction, and
`gc!setupall` pairs every channel whose name matches on both sides.

Note that **nothing is posted into the Discord channel** when a bridge is
created — only the Gryt side gets an announcement. The reply to the command you
typed is the confirmation.

`gc!help` lists everything else.

## Database

SQLite by default, at `DataFolderPath/grytcord.db`.

- Set `DatabaseEncryptionToken` and run `pnpm run encrypt` to encrypt an
  existing database with SQLCipher.
- Set `PostgresConnectionString` to use PostgreSQL instead;
  `pnpm run migrate:to-postgres` copies an existing SQLite database over.

## License

MIT, as Fluxcord. `@gryt/bot` is AGPL-3.0 and is used as a dependency.
