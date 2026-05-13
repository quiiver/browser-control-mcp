import WebSocket from "ws";
import type {
  ExtensionMessage,
  BrowserTab,
  BrowserHistoryItem,
  ServerMessage,
  TabContentExtensionMessage,
  ServerMessageRequest,
  ExtensionError,
} from "@browser-control-mcp/common";
import * as crypto from "crypto";
import { log } from "./logger";
import { recordConnection, recordDisconnect, recordError, recordPort } from "./health";

const WS_DEFAULT_PORT = 8089;
const DEFAULT_RESPONSE_TIMEOUT_MS = 5000;
const MAX_BIND_ATTEMPTS = 5;
const BIND_BACKOFFS_MS = [1000, 2000, 4000, 8000, 16000, 30000];

function responseTimeoutMs(): number {
  const v = process.env.EXTENSION_RESPONSE_TIMEOUT_MS;
  if (!v) return DEFAULT_RESPONSE_TIMEOUT_MS;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RESPONSE_TIMEOUT_MS;
}

interface ExtensionRequestResolver<T extends ExtensionMessage["resource"]> {
  resource: T;
  resolve: (value: Extract<ExtensionMessage, { resource: T }>) => void;
  reject: (reason?: string) => void;
}

export class BrowserAPI {
  private ws: WebSocket | null = null;
  private wsServer: WebSocket.Server | null = null;
  private sharedSecret: string | null = null;
  private port: number = WS_DEFAULT_PORT;

  private extensionRequestMap: Map<
    string,
    ExtensionRequestResolver<ExtensionMessage["resource"]>
  > = new Map();

  async init() {
    const { secret, port } = readConfig();
    if (!secret) {
      throw new Error(
        "EXTENSION_SECRET env var missing. See the extension's options page."
      );
    }
    this.sharedSecret = secret;
    this.port = port;
    recordPort(port);
  }

  async start() {
    const host = process.env.CONTAINERIZED ? "0.0.0.0" : "localhost";

    for (let attempt = 0; attempt < MAX_BIND_ATTEMPTS; attempt++) {
      try {
        await this.bind(host, this.port);
        log.info("websocket server listening", { host, port: this.port });
        return;
      } catch (err) {
        recordError(err);
        const isTransient = (err as NodeJS.ErrnoException)?.code === "EADDRINUSE";
        const isLast = attempt === MAX_BIND_ATTEMPTS - 1;
        if (!isTransient || isLast) {
          log.error("websocket bind failed permanently", {
            attempt: attempt + 1,
            err: String(err),
          });
          throw err;
        }
        const backoff = BIND_BACKOFFS_MS[Math.min(attempt, BIND_BACKOFFS_MS.length - 1)];
        log.warn("websocket bind failed, retrying", {
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
      recordConnection(port);

      connection.on("close", () => {
        if (this.ws === connection) this.ws = null;
        recordDisconnect();
      });
      connection.on("error", (err) => recordError(err));

      connection.on("message", (message) => {
        try {
          const decoded = JSON.parse(message.toString());
          if (isErrorMessage(decoded)) {
            this.handleExtensionError(decoded);
            return;
          }
          const signature = this.createSignature(JSON.stringify(decoded.payload));
          if (signature !== decoded.signature) {
            log.warn("invalid message signature from extension");
            return;
          }
          this.handleDecodedExtensionMessage(decoded.payload);
        } catch (err) {
          recordError(err);
        }
      });
    });
    server.on("error", (err) => recordError(err));
  }

  close() {
    this.wsServer?.close();
  }

  getSelectedPort() {
    return this.wsServer?.options.port;
  }

  async openTab(url: string): Promise<number | undefined> {
    const correlationId = this.sendMessageToExtension({
      cmd: "open-tab",
      url,
    });
    const message = await this.waitForResponse(correlationId, "opened-tab-id");
    return message.tabId;
  }

  async closeTabs(tabIds: number[]) {
    const correlationId = this.sendMessageToExtension({
      cmd: "close-tabs",
      tabIds,
    });
    await this.waitForResponse(correlationId, "tabs-closed");
  }

  async getTabList(): Promise<BrowserTab[]> {
    const correlationId = this.sendMessageToExtension({
      cmd: "get-tab-list",
    });
    const message = await this.waitForResponse(correlationId, "tabs");
    return message.tabs;
  }

  async getBrowserRecentHistory(
    searchQuery?: string
  ): Promise<BrowserHistoryItem[]> {
    const correlationId = this.sendMessageToExtension({
      cmd: "get-browser-recent-history",
      searchQuery,
    });
    const message = await this.waitForResponse(correlationId, "history");
    return message.historyItems;
  }

  async getTabContent(
    tabId: number,
    offset: number
  ): Promise<TabContentExtensionMessage> {
    const correlationId = this.sendMessageToExtension({
      cmd: "get-tab-content",
      tabId,
      offset,
    });
    return await this.waitForResponse(correlationId, "tab-content");
  }

  async reorderTabs(tabOrder: number[]): Promise<number[]> {
    const correlationId = this.sendMessageToExtension({
      cmd: "reorder-tabs",
      tabOrder,
    });
    const message = await this.waitForResponse(correlationId, "tabs-reordered");
    return message.tabOrder;
  }

  async findHighlight(tabId: number, queryPhrase: string): Promise<number> {
    const correlationId = this.sendMessageToExtension({
      cmd: "find-highlight",
      tabId,
      queryPhrase,
    });
    const message = await this.waitForResponse(
      correlationId,
      "find-highlight-result"
    );
    return message.noOfResults;
  }

  async groupTabs(
    tabIds: number[],
    isCollapsed: boolean,
    groupColor: string,
    groupTitle: string
  ): Promise<number> {
    const correlationId = this.sendMessageToExtension({
      cmd: "group-tabs",
      tabIds,
      isCollapsed,
      groupColor,
      groupTitle,
    });
    const message = await this.waitForResponse(correlationId, "new-tab-group");
    return message.groupId;
  }

  private createSignature(payload: string): string {
    if (!this.sharedSecret) {
      throw new Error("Shared secret not initialized");
    }
    const hmac = crypto.createHmac("sha256", this.sharedSecret);
    hmac.update(payload);
    return hmac.digest("hex");
  }

  private sendMessageToExtension(message: ServerMessage): string {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket is not open");
    }

    const correlationId = Math.random().toString(36).substring(2);
    const req: ServerMessageRequest = { ...message, correlationId };
    const payload = JSON.stringify(req);
    const signature = this.createSignature(payload);
    const signedMessage = {
      payload: req,
      signature: signature,
    };

    this.ws.send(JSON.stringify(signedMessage));

    return correlationId;
  }

  private handleDecodedExtensionMessage(decoded: ExtensionMessage) {
    const { correlationId } = decoded;
    const entry = this.extensionRequestMap.get(correlationId);
    if (!entry) {
      log.warn("received extension message with unknown correlationId", { correlationId });
      return;
    }
    if (entry.resource !== decoded.resource) {
      log.warn("resource mismatch on extension reply", {
        expected: entry.resource,
        got: decoded.resource,
      });
      return;
    }
    this.extensionRequestMap.delete(correlationId);
    entry.resolve(decoded);
  }

  private handleExtensionError(decoded: ExtensionError) {
    const { correlationId, errorMessage } = decoded;
    const entry = this.extensionRequestMap.get(correlationId);
    if (!entry) {
      log.warn("received extension error with unknown correlationId", { correlationId });
      return;
    }
    this.extensionRequestMap.delete(correlationId);
    entry.reject(errorMessage);
  }

  private async waitForResponse<T extends ExtensionMessage["resource"]>(
    correlationId: string,
    resource: T
  ): Promise<Extract<ExtensionMessage, { resource: T }>> {
    return new Promise<Extract<ExtensionMessage, { resource: T }>>(
      (resolve, reject) => {
        this.extensionRequestMap.set(correlationId, {
          resolve: resolve as (value: ExtensionMessage) => void,
          resource,
          reject,
        });
        setTimeout(() => {
          this.extensionRequestMap.delete(correlationId);
          reject("Timed out waiting for response");
        }, responseTimeoutMs());
      }
    );
  }
}

function readConfig() {
  return {
    secret: process.env.EXTENSION_SECRET,
    port: process.env.EXTENSION_PORT
      ? parseInt(process.env.EXTENSION_PORT, 10)
      : WS_DEFAULT_PORT,
  };
}

export function isErrorMessage(message: any): message is ExtensionError {
  return (
    message.errorMessage !== undefined && message.correlationId !== undefined
  );
}
