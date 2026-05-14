import * as net from "node:net";
import * as fs from "node:fs";
import type {
  IpcClientToDaemon,
  HelloAckFrame,
  ErrorFrame,
  ResponseFrame,
  StatusResponseFrame,
  RequestFrame,
  HelloFrame,
  DaemonStatus,
} from "@browser-control-mcp/common";
import { PROTOCOL_VERSION, verifyHelloAuth } from "./daemon-handshake";
import { log } from "./logger";

export interface IpcServerEvents {
  onRequest: (client: net.Socket, frame: RequestFrame) => void;
  onClientDisconnect: (client: net.Socket) => void;
  getStatus: () => DaemonStatus;
}

export class IpcServer {
  private server: net.Server | null = null;
  private authedClients = new WeakSet<net.Socket>();
  private connectedClients = new Set<net.Socket>();

  constructor(
    private readonly sharedSecret: string,
    private readonly daemonVersion: string,
    private readonly events: IpcServerEvents
  ) {}

  async start(socketPath: string): Promise<void> {
    await this.cleanupStaleSocket(socketPath);
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => this.handleClient(socket));
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.removeListener("error", reject);
        this.server = server;
        if (process.platform !== "win32") {
          try {
            fs.chmodSync(socketPath, 0o600);
          } catch (err) {
            log.warn("failed to chmod ipc socket", { err: String(err) });
          }
        }
        log.info("ipc-server listening", { socketPath });
        resolve();
      });
    });
  }

  private async cleanupStaleSocket(socketPath: string): Promise<void> {
    if (process.platform === "win32") return;
    if (!fs.existsSync(socketPath)) return;

    const alive = await new Promise<boolean>((resolve) => {
      const probe = net.createConnection(socketPath);
      probe.once("connect", () => {
        probe.end();
        resolve(true);
      });
      probe.once("error", () => resolve(false));
    });

    if (alive) {
      throw new Error(`another daemon is already listening on ${socketPath}`);
    }
    try {
      fs.unlinkSync(socketPath);
      log.info("removed stale ipc socket file", { socketPath });
    } catch (err) {
      log.warn("could not remove stale socket file", { err: String(err) });
    }
  }

  private handleClient(socket: net.Socket): void {
    this.connectedClients.add(socket);
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.length === 0) continue;
        this.handleLine(socket, line);
      }
    });
    socket.on("close", () => {
      this.connectedClients.delete(socket);
      this.events.onClientDisconnect(socket);
    });
    socket.on("error", (err) => {
      log.warn("ipc client socket error", { err: String(err) });
    });
  }

  private handleLine(socket: net.Socket, line: string): void {
    let frame: IpcClientToDaemon;
    try {
      frame = JSON.parse(line) as IpcClientToDaemon;
    } catch (err) {
      this.sendError(socket, `invalid JSON: ${String(err)}`, true);
      socket.end();
      return;
    }

    if (frame.type === "hello") {
      this.handleHello(socket, frame);
      return;
    }
    if (!this.authedClients.has(socket)) {
      this.sendError(socket, "client must send hello before any other frame", true);
      socket.end();
      return;
    }
    if (frame.type === "request") {
      this.events.onRequest(socket, frame);
      return;
    }
    if (frame.type === "status") {
      this.sendStatus(socket);
      return;
    }
    this.sendError(socket, `unknown frame type: ${(frame as any).type}`);
  }

  private handleHello(socket: net.Socket, frame: HelloFrame): void {
    if (frame.protocolVersion !== PROTOCOL_VERSION) {
      this.sendError(
        socket,
        `protocol version mismatch: client=${frame.protocolVersion} daemon=${PROTOCOL_VERSION}`,
        true
      );
      socket.end();
      return;
    }
    let ok = false;
    try {
      ok = verifyHelloAuth(this.sharedSecret, frame);
    } catch {
      ok = false;
    }
    if (!ok) {
      this.sendError(socket, "hello auth failed", true);
      socket.end();
      return;
    }
    this.authedClients.add(socket);
    const ack: HelloAckFrame = {
      type: "hello-ack",
      protocolVersion: PROTOCOL_VERSION,
      daemonPid: process.pid,
      daemonVersion: this.daemonVersion,
    };
    this.writeFrame(socket, ack);
    log.info("ipc client authenticated", {
      clientPid: frame.clientPid,
      clientVersion: frame.clientVersion,
    });
  }

  private sendStatus(socket: net.Socket): void {
    const status: StatusResponseFrame = {
      type: "status-response",
      daemon: this.events.getStatus(),
    };
    this.writeFrame(socket, status);
  }

  sendResponse(socket: net.Socket, frame: ResponseFrame): void {
    this.writeFrame(socket, frame);
  }

  private sendError(socket: net.Socket, error: string, fatal = false): void {
    const frame: ErrorFrame = { type: "error", error };
    if (fatal) frame.fatal = true;
    this.writeFrame(socket, frame);
  }

  private writeFrame(socket: net.Socket, frame: object): void {
    if (socket.destroyed || !socket.writable) return;
    socket.write(JSON.stringify(frame) + "\n");
  }

  close(): void {
    for (const socket of this.connectedClients) {
      socket.destroy();
    }
    this.connectedClients.clear();
    this.server?.close();
  }
}
