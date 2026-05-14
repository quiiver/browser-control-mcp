import type { ServerMessage } from "./server-messages";
import type { ExtensionMessage } from "./extension-messages";

export interface HelloFrame {
  type: "hello";
  protocolVersion: number;
  clientPid: number;
  clientVersion: string;
  nonce: string;
  auth: string;
}

export interface HelloAckFrame {
  type: "hello-ack";
  protocolVersion: number;
  daemonPid: number;
  daemonVersion: string;
}

export interface ErrorFrame {
  type: "error";
  error: string;
  fatal?: boolean;
}

export interface RequestFrame {
  type: "request";
  clientCorrelationId: string;
  message: ServerMessage;
}

export interface ResponseFrame {
  type: "response";
  clientCorrelationId: string;
  ok: boolean;
  payload?: ExtensionMessage;
  error?: string;
}

export interface StatusRequestFrame {
  type: "status";
}

export interface DaemonStatus {
  startedAt: string;
  pid: number;
  wsConnected: boolean;
  wsPort: number | null;
  lastConnectionAt: string | null;
  lastDisconnectAt: string | null;
  lastErrorAt: string | null;
  lastErrorMessage: string | null;
  logFilePath: string;
  daemonVersion: string;
}

export interface StatusResponseFrame {
  type: "status-response";
  daemon: DaemonStatus;
}

export type IpcClientToDaemon = HelloFrame | RequestFrame | StatusRequestFrame;
export type IpcDaemonToClient =
  | HelloAckFrame
  | ResponseFrame
  | StatusResponseFrame
  | ErrorFrame;
