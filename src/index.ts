import { Bot, Context } from "grammy";
import * as path from "node:path";
import * as fs from "node:fs";
import { runCommand } from "./tools/runtime/runCommand.js";
import { replyChunks } from "./tools/runtime/replyChunks.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("[terra] ERROR: BOT_TOKEN env var is required");
  process.exit(1);
}

/**
 * Comma-separated list of Telegram user IDs allowed to use the bot.
 * Example: ALLOWED_USERS=123456789,987654321
 * Leave empty to disable user filtering (not recommended in production).
 */
const ALLOWED_USERS: Set<number> = (() => {
  const raw = process.env.ALLOWED_USERS ?? "";
  if (!raw.trim()) return new Set<number>();
  return new Set(
    raw
      .split(",")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => !isNaN(n))
  );
})();

/**
 * The safe directory where user scripts must reside.
 * All paths are resolved and validated against this directory.
 */
const SCRIPTS_DIR =
  process.env.SCRIPTS_DIR ?? "/home/yanser/terra-ia/scripts";

// Ensure the scripts directory exists
if (!fs.existsSync(SCRIPTS_DIR)) {
  fs.mkdirSync(SCRIPTS_DIR, { recursive: true });
  console.log(`[terra] Created scripts directory: ${SCRIPTS_DIR}`);
}

/** Timeout for script execution (default 2 minutes). */
const SCRIPT_TIMEOUT_MS = parseInt(
  process.env.SCRIPT_TIMEOUT_MS ?? "120000",
  10
);

/** Maximum output bytes returned to the user (default 512 KB). */
const MAX_OUTPUT_BYTES = parseInt(
  process.env.MAX_OUTPUT_BYTES ?? "524288",
  10
);

// ---------------------------------------------------------------------------
// Interpreter whitelist keyed by file extension
// ---------------------------------------------------------------------------
type InterpreterConfig = { command: string; extraArgs: string[] };

const INTERPRETERS: Record<string, InterpreterConfig> = {
  ".ts": { command: "npx", extraArgs: ["tsx"] },
  ".js": { command: "node", extraArgs: [] },
  ".py": { command: "python3", extraArgs: [] },
  ".sh": { command: "bash", extraArgs: [] },
};

// ---------------------------------------------------------------------------
// Bot setup
// ---------------------------------------------------------------------------
const bot = new Bot(BOT_TOKEN);

// ---------------------------------------------------------------------------
// Middleware: allowed-users gate
// ---------------------------------------------------------------------------
bot.use(async (ctx: Context, next) => {
  if (ALLOWED_USERS.size === 0) {
    // No filter configured – allow everyone (warn on start)
    return next();
  }
  const userId = ctx.from?.id;
  if (userId !== undefined && ALLOWED_USERS.has(userId)) {
    return next();
  }
  // Silently ignore unauthorised users (do not leak bot existence)
  console.log(`[terra] Blocked user: id=${userId ?? "unknown"}`);
});

// ---------------------------------------------------------------------------
// /run command
// ---------------------------------------------------------------------------
bot.command("run", async (ctx: Context) => {
  let rawArgs: string;
  if (typeof ctx.match === "string") {
    rawArgs = ctx.match.trim();
  } else {
    rawArgs = (ctx.match?.[0] ?? "").trim();
  }

  if (!rawArgs) {
    await ctx.reply(
      "Uso: /run <script> [args...]\n" +
        "Ejemplo: /run hello.js\n" +
        "Extensiones permitidas: .ts .js .py .sh\n" +
        `Scripts deben estar en: ${SCRIPTS_DIR}`
    );
    return;
  }

  // Parse script name and arguments
  const parts = rawArgs.split(/\s+/);
  const scriptName = parts[0];
  const userArgs = parts.slice(1);

  // --- Security: reject absolute paths and traversal attempts ---
  if (
    path.isAbsolute(scriptName) ||
    scriptName.includes("..") ||
    scriptName.includes("/")
  ) {
    await ctx.reply(
      "❌ Nombre de script inválido. Solo se permiten nombres de archivo simples (sin rutas ni '..')."
    );
    return;
  }

  // --- Security: resolve final path and confirm it's inside SCRIPTS_DIR ---
  const resolvedScript = path.resolve(SCRIPTS_DIR, scriptName);
  const relToScripts = path.relative(path.resolve(SCRIPTS_DIR), resolvedScript);
  if (relToScripts.startsWith("..") || path.isAbsolute(relToScripts)) {
    await ctx.reply("❌ Acceso denegado: el script está fuera del directorio permitido.");
    return;
  }

  // --- Security: check for symlink escape ---
  try {
    const realScript = fs.realpathSync(resolvedScript);
    const realScriptsDir = fs.realpathSync(SCRIPTS_DIR);
    const relReal = path.relative(realScriptsDir, realScript);
    if (relReal.startsWith("..") || path.isAbsolute(relReal)) {
      await ctx.reply(
        "❌ Acceso denegado: el script apunta fuera del directorio seguro (symlink)."
      );
      return;
    }
  } catch {
    // realpathSync throws if the file does not exist
    await ctx.reply(
      `❌ Script no encontrado: \`${scriptName}\`\nAsegúrate de que esté en: ${SCRIPTS_DIR}`
    );
    return;
  }

  // --- Check extension against whitelist ---
  const ext = path.extname(scriptName).toLowerCase();
  const interp = INTERPRETERS[ext];
  if (!interp) {
    const allowed = Object.keys(INTERPRETERS).join(", ");
    await ctx.reply(
      `❌ Extensión no permitida: \`${ext || "(ninguna)"}\`\nExtensiones soportadas: ${allowed}`
    );
    return;
  }

  // --- Acknowledge immediately so the user knows we started ---
  await ctx.reply(`⏳ Ejecutando \`${scriptName}\`…`);

  const command = interp.command;
  const args = [...interp.extraArgs, resolvedScript, ...userArgs];

  console.log(
    `[terra] /run user=${ctx.from?.id} script=${scriptName} args=${JSON.stringify(userArgs)}`
  );

  const result = await runCommand(command, args, {
    cwd: SCRIPTS_DIR,
    timeoutMs: SCRIPT_TIMEOUT_MS,
    maxOutputBytes: MAX_OUTPUT_BYTES,
  });

  // --- Build the reply ---
  const lines: string[] = [];

  if (result.timedOut) {
    lines.push(`⏱ Timeout alcanzado (${SCRIPT_TIMEOUT_MS / 1000}s) – proceso terminado.`);
  }
  if (result.truncated) {
    lines.push(`⚠️ Output truncado (superó ${MAX_OUTPUT_BYTES / 1024} KB).`);
  }

  const hasOutput = result.stdout || result.stderr;

  if (!hasOutput && result.code === 0) {
    lines.push("✅ Script finalizado sin salida.");
  } else if (!hasOutput) {
    lines.push(
      `⚠️ Script terminó con código ${result.code ?? result.signal} sin salida.`
    );
  }

  const summary = lines.join("\n");

  if (summary) {
    await ctx.reply(summary);
  }

  if (result.stdout) {
    await replyChunks(ctx, result.stdout);
  }

  if (result.stderr) {
    await replyChunks(ctx, `⚠️ stderr:\n${result.stderr}`);
  }

  if (!result.stdout && !result.stderr && result.code !== 0) {
    await ctx.reply(
      `❌ Exit code: ${result.code ?? result.signal} (${result.durationMs}ms)`
    );
  }
});

// ---------------------------------------------------------------------------
// /start – welcome message
// ---------------------------------------------------------------------------
bot.command("start", async (ctx: Context) => {
  await ctx.reply(
    "🤖 Terra activa.\n\nComandos:\n" +
      "• /run <script> [args] – ejecutar un script\n\n" +
      `Scripts deben estar en: ${SCRIPTS_DIR}`
  );
});

// ---------------------------------------------------------------------------
// Start bot
// ---------------------------------------------------------------------------
console.log("[terra] Starting bot…");
bot.start({
  onStart: () => console.log("[terra] Bot is running."),
});
