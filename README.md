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
