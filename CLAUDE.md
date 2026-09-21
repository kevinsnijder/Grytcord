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
alongside the access token. It has to be in the query string because these URLs
end up where a header cannot follow, such as an `<img src>` in Gryt's own
client.

`GrytServerConnection.fileUrl()` is the only place that builds one, and it
attaches the token. Build such a URL by hand and it comes back 401, which shows
up as a missing picture rather than an error.

## Avatars do not come from the Gryt host

**A Gryt file URL cannot be a Discord webhook's `avatar_url`.** Discord's client
loads a `cdn.discordapp.com` avatar directly and pulls anything else through
its image proxy, and the proxy never comes back with a Gryt upload — the token
in the query string does not survive the trip, so it gets a 401 instead of an
image. Nothing anywhere reports this. The message arrives with a blank face.

Nothing in the API will tell you whether a picture drew, either: `author.avatar`
on the message Discord hands back is null even for the ones that work. Only
looking at Discord answers that. All of the above was established by posting
through one webhook six times — no `avatar_url`, a `cdn.discordapp.com` PNG
with and without a query string, a Gryt URL, a Gryt URL with a flattened still
behind it — and seeing which messages ended up with a face. Do that again
rather than reasoning about it, if any of this ever seems wrong.

So `bridgeAvatarURL()` (`utils/AvatarUrl.js`) puts the picture somewhere
Discord will read it: decode the Gryt file with `sharp`, flatten it to a still
128px PNG (an avatar may be an animated GIF, and `?thumb=1` answers in AVIF),
and write it into `DataFolderPath/avatars`. `utils/AvatarStore.js` owns that
folder; `PublicBaseUrl` is where it is published, either by a web server
pointed at the folder or by Grytcord's own port, and without it there is
nowhere to publish to and messages get blank faces. The file on disk is the
cache — named after a digest of host and file id, so it is stable across
restarts and old messages keep their faces.

Discord's app emoji slots were considered for this and rejected: they are a
finite resource the user wants for emoji.

`sharp` is the only native dependency, loaded through a dynamic `import` so a
failed install costs blank faces rather than a bot that will not start.
`bridgeAvatarURL()` is the only way to get a face for Discord; a raw
`fileUrl()` of an avatar will not draw.

## Logging

`log(category, ...)` drops anything whose category is not switched on, and the
default list does not include `DEBUG` or `DB` — so the per-message trace is
invisible unless asked for. Two things are exempt from that, and both exist
because a bridge that fails silently costs an afternoon:

- `logError(scope, message, error)` always prints, with the stack. Use it for
  anything that went wrong; `log("GRYT", e)` on its own can be filtered away.
- `GRYTCORD_LOG` in the environment overrides `LoggingCategories`, so a
  container with a read-only `config.js` can still be told to talk:
  `-e GRYTCORD_LOG=ALL`.

`AVATAR` is the author-picture trail: what Gryt sent, what the file turned out
to be, which rendition went to Discord, and whether Discord kept it. Log URLs
through `redactFileUrl()` — a file URL carries a live read token.

A diagnostic line must never be the thing that throws. Anything that reaches
into a shape the server owns (`Object.keys(member)`, a member list that may not
have arrived) goes inside a `try`.

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
