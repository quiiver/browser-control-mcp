import { log } from "./logger";

export interface Health {
  startedAt: string;
  wsConnected: boolean;
  port: number | null;
  lastConnectionAt: string | null;
  lastDisconnectAt: string | null;
  lastErrorAt: string | null;
  lastErrorMessage: string | null;
  logFilePath: string;
}

export const health: Health = {
  startedAt: new Date().toISOString(),
  wsConnected: false,
  port: null,
  lastConnectionAt: null,
  lastDisconnectAt: null,
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

export function recordConnection(port: number): void {
  health.wsConnected = true;
  health.port = port;
  health.lastConnectionAt = new Date().toISOString();
  log.info("websocket connection established", { port });
}

export function recordDisconnect(): void {
  health.wsConnected = false;
  health.lastDisconnectAt = new Date().toISOString();
  log.info("websocket connection closed");
}

export function recordPort(port: number): void {
  health.port = port;
}
