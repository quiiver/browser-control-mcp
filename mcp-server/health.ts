import { log } from "./logger";
import { resolveSocketPath } from "./socket-path";

export interface ClientHealth {
  startedAt: string;
  daemonReachable: boolean;
  daemonSocketPath: string;
  lastErrorAt: string | null;
  lastErrorMessage: string | null;
  logFilePath: string;
}

export const health: ClientHealth = {
  startedAt: new Date().toISOString(),
  daemonReachable: false,
  daemonSocketPath: resolveSocketPath(),
  lastErrorAt: null,
  lastErrorMessage: null,
  logFilePath: log.filePath(),
};

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export function recordError(err: unknown): void {
  const msg = errMessage(err);
  health.lastErrorAt = new Date().toISOString();
  health.lastErrorMessage = msg;
  const stack = err instanceof Error ? err.stack : undefined;
  log.error(msg, stack ? { stack } : undefined);
}

export function recordDaemonReachable(reachable: boolean): void {
  health.daemonReachable = reachable;
}
