import WebSocket from "ws";
import * as crypto from "node:crypto";
import type {
  ServerMessage,
  ServerMessageRequest,
  ExtensionMessage,
  ExtensionError,
} from "@browser-control-mcp/common";
import { log } from "./logger";

const MAX_BIND_ATTEMPTS = 5;
const BIND_BACKOFFS_MS = [1000, 2000, 4000, 8000, 16000];

export interface WsBridgeEvents {
  onExtensionMessage: (msg: ExtensionMessage) => void;
  onExtensionError: (err: ExtensionError) => void;
  onConnection: (port: number) => void;
  onDisconnect: () => void;
  onWsError: (err: unknown) => void;
}

export class WsBridge {
  private wsServer: WebSocket.Server | null = null;
  private ws: WebSocket | null = null;
  private events: WsBridgeEvents;
  private port: number;

  constructor(
    private readonly sharedSecret: string,
    port: number,
    events: WsBridgeEvents
  ) {
    this.port = port;
    this.events = events;
  }

  async start(): Promise<void> {
    const host = process.env.CONTAINERIZED ? "0.0.0.0" : "localhost";

    for (let attempt = 0; attempt < MAX_BIND_ATTEMPTS; attempt++) {
      try {
        await this.bind(host, this.port);
        log.info("ws-bridge listening", { host, port: this.port });
        return;
      } catch (err) {
        this.events.onWsError(err);
        const isTransient = (err as NodeJS.ErrnoException)?.code === "EADDRINUSE";
        const isLast = attempt === MAX_BIND_ATTEMPTS - 1;
        if (!isTransient || isLast) {
          log.error("ws-bridge bind failed permanently", {
            attempt: attempt + 1,
            err: String(err),
          });
          throw err;
        }
        const backoff = BIND_BACKOFFS_MS[Math.min(attempt, BIND_BACKOFFS_MS.length - 1)];
        log.warn("ws-bridge bind failed, retrying", {
          attempt: attempt + 1,
          backoffMs: backoff,
        });
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  }

  private bind(host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = new WebSocket.Server({ host, port });
      const onError = (err: Error) => {
        server.removeListener("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        server.removeListener("error", onError);
        this.wsServer = server;
        this.attachServerHandlers(server, port);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
    });
  }

  private attachServerHandlers(server: WebSocket.Server, port: number) {
    server.on("connection", (connection) => {
      this.ws = connection;
      this.events.onConnection(port);

      connection.on("close", () => {
        if (this.ws === connection) this.ws = null;
        this.events.onDisconnect();
      });
      connection.on("error", (err) => this.events.onWsError(err));

      connection.on("message", (message) => {
        try {
          const decoded = JSON.parse(message.toString());
          if (isErrorMessage(decoded)) {
            this.events.onExtensionError(decoded);
            return;
          }
          const signature = this.createSignature(JSON.stringify(decoded.payload));
          if (signature !== decoded.signature) {
            log.warn("invalid message signature from extension");
            return;
          }
          this.events.onExtensionMessage(decoded.payload);
        } catch (err) {
          this.events.onWsError(err);
        }
      });
    });
    server.on("error", (err) => this.events.onWsError(err));
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  send(message: ServerMessage, correlationId: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket is not open");
    }
    const req: ServerMessageRequest = { ...message, correlationId };
    const payload = JSON.stringify(req);
    const signature = this.createSignature(payload);
    this.ws.send(JSON.stringify({ payload: req, signature }));
  }

  private createSignature(payload: string): string {
    const hmac = crypto.createHmac("sha256", this.sharedSecret);
    hmac.update(payload);
    return hmac.digest("hex");
  }

  close() {
    this.wsServer?.close();
  }
}

export function isErrorMessage(message: any): message is ExtensionError {
  return (
    message != null &&
    message.errorMessage !== undefined &&
    message.correlationId !== undefined
  );
}
