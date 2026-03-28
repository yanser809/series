# series / Terra Bot

Terra is a Telegram bot built with [grammY](https://grammy.dev/) that can reliably execute scripts and skills without hanging or crashing.

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Set required environment variables
export BOT_TOKEN="your-telegram-bot-token"
export ALLOWED_USERS="123456789,987654321"   # Telegram user IDs (comma-separated)

# 3. Build and run
npm run build
npm start

# OR run in dev mode (no build step)
npm run dev
```

### Running under PM2

```bash
pm2 start npm --name terra-ia -- start
pm2 save
pm2 startup
```

---

## Environment Variables

| Variable           | Default                           | Description                                                 |
| ------------------ | --------------------------------- | ----------------------------------------------------------- |
| `BOT_TOKEN`        | *(required)*                      | Telegram Bot API token                                       |
| `ALLOWED_USERS`    | *(empty = allow all)*             | Comma-separated Telegram user IDs allowed to use the bot    |
| `SCRIPTS_DIR`      | `/home/yanser/terra-ia/scripts`   | Safe directory where scripts must reside                     |
| `SCRIPT_TIMEOUT_MS`| `120000`                          | Hard kill timeout per script (milliseconds)                  |
| `MAX_OUTPUT_BYTES` | `524288`                          | Maximum combined stdout+stderr before truncation (bytes)     |

---

## `/run` Command

Execute a script from the safe scripts directory.

**Syntax:**

```
/run <script> [args...]
```

**Examples:**

```
/run hello.js
/run hello.js Terra
/run analysis.py --mode full
/run deploy.sh staging
/run transform.ts --input data.json
```

### Supported Extensions

| Extension | Interpreter       |
| --------- | ----------------- |
| `.js`     | `node`            |
| `.ts`     | `npx tsx`         |
| `.py`     | `python3`         |
| `.sh`     | `bash`            |

### Where to Place Scripts

Scripts must be placed inside the configured **SCRIPTS_DIR** (default: `/home/yanser/terra-ia/scripts`).  
The directory is created automatically on startup if it does not exist.

```bash
# Copy a script to the safe directory
cp my-script.js /home/yanser/terra-ia/scripts/

# Then run it from Telegram
/run my-script.js
```

### Safety Rules

- **Only files inside `SCRIPTS_DIR`** can be executed. Path traversal (`..`), absolute paths, and symlinks that escape the directory are rejected.
- **Only the whitelisted extensions** above are accepted. Unknown extensions are rejected with a clear error.
- **Only allowed users** (configured via `ALLOWED_USERS`) can send commands. Unauthorised users are silently ignored.

---

## Architecture

```
src/
├── index.ts                      # Bot entry point, /run command, middleware
└── tools/
    └── runtime/
        ├── runCommand.ts         # Reusable command runner (spawn + timeout + output limit)
        └── replyChunks.ts        # Telegram chunked-reply helper

scripts/                          # Safe directory for user scripts
└── hello.js                      # Self-test script
```

### `runCommand` API

```ts
import { runCommand } from "./tools/runtime/runCommand.js";

const result = await runCommand("node", ["script.js"], {
  cwd: "/path/to/dir",
  timeoutMs: 30_000,        // kill after 30 s
  maxOutputBytes: 256_000,  // truncate after 256 KB
  env: { MY_VAR: "value" },
});

// result: { code, signal, stdout, stderr, truncated, durationMs, timedOut }
```

Features:
- Uses `child_process.spawn` (no maxBuffer issues).
- Hard SIGKILL on timeout or output-size exceeded.
- On Linux, kills the entire **process group** (detached + `kill(-pid)`) so no zombie children.
- Returns a structured result; never throws for non-zero exit codes.

### `replyChunks` API

```ts
import { replyChunks } from "./tools/runtime/replyChunks.js";

await replyChunks(ctx, longOutput);           // default 3500 char chunks
await replyChunks(ctx, longOutput, 1000);     // custom chunk size
```

---

## Self-Test / Manual Test Steps

1. **Start the bot** (`npm run dev` or `pm2 start`).
2. **Send `/run hello.js`** from Telegram — expect:
   ```
   ⏳ Ejecutando `hello.js`…
   Hola, mundo!
   Node.js v24.x.x
   Fecha: 2026-…
   ```
3. **Test with args**: `/run hello.js Terra` — output should say `Hola, Terra!`.
4. **Test path traversal**: `/run ../etc/passwd` — expect rejection message.
5. **Test unknown extension**: `/run test.rb` — expect unsupported extension message.
6. **Test timeout** (create a hanging script):
   ```js
   // scripts/hang.js
   setTimeout(() => {}, 9999999);
   ```
   Set `SCRIPT_TIMEOUT_MS=5000`, run `/run hang.js` — expect timeout message after 5 s.
7. **Test large output** (create an output-heavy script):
   ```js
   // scripts/bigout.js
   for (let i = 0; i < 100000; i++) console.log("line " + i);
   ```
   Run `/run bigout.js` — output is truncated and bot remains responsive.
