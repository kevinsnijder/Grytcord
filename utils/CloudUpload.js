import { log } from "./Logger.js";

/**
 * Discord's two-step upload: ask for somewhere to put the bytes, PUT them
 * there, then name the result on the message. Bigger files than a plain
 * multipart send allows, and it is how the Gryt to Discord direction carries
 * attachments.
 *
 * @param {import("discord.js").Client} discordClient
 * @param {string} channelId
 * @param {Array<{ attachment: Buffer, name: string, description?: string }>} files
 * @returns {Promise<Array<{ id: string, filename: string, uploaded_filename: string, description?: string }>>}
 */
export async function cloudUploadAttachments(discordClient, channelId, files) {
  const created =
    /** @type {{ attachments: Array<{ id?: string, upload_url: string, upload_filename: string }> }} */ (
      await discordClient.rest.post(`/channels/${channelId}/attachments`, {
        body: {
          files: files.map((file, index) => ({
            id: index.toString(),
            filename: file.name,
            file_size: file.attachment.byteLength,
          })),
        },
      })
    );

  /** @type {Array<{ id: string, filename: string, uploaded_filename: string, description?: string }>} */
  const attachments = [];
  for (const [index, upload] of created.attachments.entries()) {
    const file = files[index];
    if (!file) continue;
    const res = await fetch(upload.upload_url, {
      method: "PUT",
      body: file.attachment,
    });
    if (!res.ok) {
      log(
        "DISCORD",
        `Failed to upload attachment ${file.name} to Discord cloud storage: ${res.status} ${res.statusText}`,
      );
      continue;
    }
    attachments.push({
      id: upload.id ?? index.toString(),
      filename: file.name,
      uploaded_filename: upload.upload_filename,
      description: file.description,
    });
  }
  return attachments;
}
