import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function freshTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bcm-logger-"));
}

function readLines(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter((l) => l.length > 0);
}

test("writes JSONL lines at or above the configured level", () => {
  const dir = freshTmpDir();
  const logFile = path.join(dir, "server.log");
  process.env.LOG_FILE = logFile;
  process.env.LOG_LEVEL = "warn";
  delete require.cache[require.resolve("./logger")];
  const { log } = require("./logger");

  log.debug("should be filtered");
  log.info("should be filtered too");
  log.warn("a warning", { code: 42 });
  log.error("an error");

  const lines = readLines(logFile);
  assert.equal(lines.length, 2);

  const warn = JSON.parse(lines[0]);
  assert.equal(warn.level, "warn");
  assert.equal(warn.msg, "a warning");
  assert.equal(warn.code, 42);
  assert.match(warn.ts, /^\d{4}-\d{2}-\d{2}T/);

  const err = JSON.parse(lines[1]);
  assert.equal(err.level, "error");
  assert.equal(err.msg, "an error");
});

test("rotates when the log file exceeds LOG_MAX_BYTES", () => {
  const dir = freshTmpDir();
  const logFile = path.join(dir, "server.log");
  process.env.LOG_FILE = logFile;
  process.env.LOG_LEVEL = "info";
  process.env.LOG_MAX_BYTES = "500";
  process.env.LOG_MAX_FILES = "3";
  delete require.cache[require.resolve("./logger")];
  const { log } = require("./logger");

  for (let i = 0; i < 50; i++) {
    log.info("filler line padding padding padding padding padding", { i });
  }

  assert.ok(fs.existsSync(logFile), "current log file exists");
  assert.ok(fs.existsSync(logFile + ".1"), "rotated .1 exists");
  const sz = fs.statSync(logFile).size;
  assert.ok(sz <= 1500, `current file should be small after rotation, was ${sz}`);
  assert.ok(!fs.existsSync(logFile + ".4"), ".4 should not exist (cap is 3)");
});

test("falls back to console.error if log file path is unwritable", () => {
  process.env.LOG_FILE = "/this/path/does/not/exist/and/cannot/be/created/server.log";
  process.env.LOG_LEVEL = "info";
  delete require.cache[require.resolve("./logger")];

  const origErr = console.error;
  const captured: unknown[][] = [];
  console.error = (...args: unknown[]) => { captured.push(args); };
  try {
    const { log } = require("./logger");
    log.error("boom");
  } finally {
    console.error = origErr;
  }
  assert.ok(captured.length >= 1, "console.error called as fallback");
  const sawBoom = captured.some((args) =>
    args.some((a) => typeof a === "string" && a.includes("boom"))
  );
  assert.ok(sawBoom, "expected console.error fallback to log the boom message");
});

test("filePath() returns the resolved log file path", () => {
  const dir = freshTmpDir();
  const logFile = path.join(dir, "server.log");
  process.env.LOG_FILE = logFile;
  process.env.LOG_LEVEL = "info";
  delete require.cache[require.resolve("./logger")];
  const { log } = require("./logger");
  assert.equal(log.filePath(), logFile);
});
