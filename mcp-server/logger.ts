import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export type LogLevel = "error" | "warn" | "info" | "debug";

const LEVEL_RANK: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

function resolveLogFile(): string {
  if (process.env.LOG_FILE) return process.env.LOG_FILE;
  return path.join(os.homedir(), ".browser-control-mcp", "logs", "server.log");
}

function resolveLevel(): LogLevel {
  const v = (process.env.LOG_LEVEL || "info").toLowerCase();
  if (v === "error" || v === "warn" || v === "info" || v === "debug") return v;
  return "info";
}

function resolveInt(envName: string, fallback: number): number {
  const v = process.env[envName];
  if (!v) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const LOG_FILE = resolveLogFile();
const LOG_LEVEL = resolveLevel();
const LOG_MAX_BYTES = resolveInt("LOG_MAX_BYTES", 5_000_000);
const LOG_MAX_FILES = resolveInt("LOG_MAX_FILES", 5);

let fileUsable = true;
try {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
} catch (err) {
  fileUsable = false;
  console.error("logger: could not create log dir, falling back to console", err);
}

function rotateIfNeeded() {
  if (!fileUsable) return;
  let size = 0;
  try {
    size = fs.statSync(LOG_FILE).size;
  } catch {
    return;
  }
  if (size < LOG_MAX_BYTES) return;

  for (let i = LOG_MAX_FILES - 1; i >= 1; i--) {
    const src = `${LOG_FILE}.${i}`;
    const dst = `${LOG_FILE}.${i + 1}`;
    if (fs.existsSync(src)) {
      try {
        if (i + 1 > LOG_MAX_FILES) fs.unlinkSync(src);
        else fs.renameSync(src, dst);
      } catch {
        // ignore — best-effort rotation
      }
    }
  }
  try {
    fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
  } catch {
    // ignore
  }
}

function write(level: LogLevel, msg: string, meta?: object) {
  if (LEVEL_RANK[level] > LEVEL_RANK[LOG_LEVEL]) return;
  const entry = { ts: new Date().toISOString(), level, msg, ...(meta || {}) };
  const line = JSON.stringify(entry) + "\n";

  if (!fileUsable) {
    console.error(line.trimEnd());
    return;
  }
  try {
    rotateIfNeeded();
    fs.appendFileSync(LOG_FILE, line);
  } catch (err) {
    fileUsable = false;
    console.error("logger: write failed, falling back to console", err);
    console.error(line.trimEnd());
  }
}

export const log = {
  error: (msg: string, meta?: object) => write("error", msg, meta),
  warn: (msg: string, meta?: object) => write("warn", msg, meta),
  info: (msg: string, meta?: object) => write("info", msg, meta),
  debug: (msg: string, meta?: object) => write("debug", msg, meta),
  filePath: () => LOG_FILE,
};
