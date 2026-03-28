import type { Context } from "grammy";

/** Maximum characters per Telegram message (hard limit is 4096; we leave margin). */
const TELEGRAM_CHUNK_SIZE = 3500;

/**
 * Send `text` to the Telegram chat, splitting it into chunks when needed.
 * Each chunk is sent sequentially so Telegram ordering is preserved.
 */
export async function replyChunks(
  ctx: Context,
  text: string,
  chunkSize: number = TELEGRAM_CHUNK_SIZE
): Promise<void> {
  const content = (text ?? "").toString();
  if (!content.trim()) {
    await ctx.reply("(sin salida)");
    return;
  }
  for (let i = 0; i < content.length; i += chunkSize) {
    await ctx.reply(content.slice(i, i + chunkSize));
  }
}
