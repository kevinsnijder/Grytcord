# Grytcord

A Discord <-> Gryt bridge. Ported from Fluxcord (Discord <-> Fluxer), which is
worth reading when something here looks odd: most of the structure is its
structure.

## Layout

```
index.js                  wiring: both clients, every event, startup
db/index.js               Sequelize models (SQLite/SQLCipher or Postgres)
migrations/               umzug migrations, run by `pnpm run migrate`
commands/                 one file per command, loaded at runtime
utils/GrytClient.js       every Gryt server behind one event stream
utils/GrytMessage.js      one Gryt message, in the shape the rest talks in
utils/DiscordHandler.js   Discord -> Gryt
utils/GrytHandler.js      Gryt -> Discord
utils/Compat.js           one payload shape, rendered per platform
```

## The two things to know before changing a handler

**1. Gryt gives a bot two ways to post, and they are not interchangeable.**

- A *webhook* message carries the author's name and picture and can hold cards
  (embeds). It cannot hold files, cannot carry a reply, and **cannot be edited**
  — `chat:edit` is own-messages-only and a webhook message is not the bot's.
- A *bot* message (`chat:send`) can hold real uploads and a real reply, and can
  be edited and deleted later. It has no per-message name or picture, and no
  cards.

Grytcord posts through the webhook unless the message has files. Which route was
taken is stored as `grytSentVia` on the MessageMap row, and the edit and delete
handlers read it. Do not make either handler guess.

**2. A Gryt reaction is a toggle, not add/remove.** `GrytServerConnection` keeps
the last known reaction state per message so a relayed removal removes rather
than adds. `setReaction` is the only thing that should call `chat:react`.

## Reading a file from Gryt

`GET /api/uploads/files/:id` is **not** public: it wants a *file token* in the
query string (`?t=`), which `server:joined` and `token:refreshed` hand out
alongside the access token. A header is no use — these URLs are handed to
Discord as a webhook's `avatar_url` and fetched by Discord, not by us.

`GrytServerConnection.fileUrl()` is the only place that builds one, and it
attaches the token. Build such a URL by hand and it comes back 401, which shows
up as a missing avatar rather than an error.

## Things Gryt does not have

Pins. Message URLs. Bulk delete (deleting several is several deletes). Per-member
permissions a bot can read — which is why elevation on the Gryt side is a role
check against `GrytElevatedRoles`.

## Deliberate behaviour

Creating a bridge posts **nothing into the Discord channel**. The Gryt side gets
an announcement; the Discord side gets only the reply to the command that was
typed. This is a requirement, not an oversight — see `announceBridge`.

With `AutoVerifyBridges` on, that goes further: `bridge` and `bridgeall` take
effect from one side with no approval on the other, and a success on Discord is
a ✅ reaction on the command rather than any message at all (`confirmQuietly`).
Failures still reply — a failure nobody can see is worse than a message nobody
wanted.

The "bridging N channels" line is read from the database, so anything that
creates or removes a bridge calls `refreshPresence()`. Counting once at startup
is what left it saying zero forever.

Voice bridging is not ported.

## Style

Plain JS with JSDoc types, ESM, two-space indent, same as Fluxcord. `pnpm
--package=typescript dlx tsc --noEmit` is the only check that runs in CI.
