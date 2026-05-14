import * as child_process from "node:child_process";
import * as path from "node:path";
import * as os from "node:os";
import type {
  BrowserTab,
  BrowserHistoryItem,
  TabContentExtensionMessage,
  DaemonStatus,
} from "@browser-control-mcp/common";
import { log } from "./logger";
import { resolveSocketPath } from "./socket-path";
import { DaemonClient } from "./daemon-client";

const CLIENT_VERSION = "1.7.0";
const DEFAULT_RESPONSE_TIMEOUT_MS = 5000;

function responseTimeoutMs(): number {
  const v = process.env.EXTENSION_RESPONSE_TIMEOUT_MS;
  if (!v) return DEFAULT_RESPONSE_TIMEOUT_MS;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RESPONSE_TIMEOUT_MS;
}

export class BrowserAPI {
  private client: DaemonClient | null = null;

  async init(): Promise<void> {
    const secret = process.env.EXTENSION_SECRET;
    if (!secret) {
      throw new Error(
        "EXTENSION_SECRET env var missing. See the extension's options page."
      );
    }
    const socketPath = resolveSocketPath();
    this.client = new DaemonClient({
      socketPath,
      secret,
      clientVersion: CLIENT_VERSION,
      requestTimeoutMs: responseTimeoutMs(),
      spawnDaemon: async () => {
        const daemonScript = path.join(__dirname, "daemon.js");
        const daemonLogFile = path.join(
          os.homedir(),
          ".browser-control-mcp",
          "logs",
          "daemon.log"
        );
        const child = child_process.spawn(
          process.execPath,
          [daemonScript],
          {
            detached: true,
            stdio: "ignore",
            env: { ...process.env, LOG_FILE: daemonLogFile },
          }
        );
        child.unref();
        log.info("spawned daemon", { pid: child.pid, daemonLogFile });
        // Brief pause to let the daemon bind the socket before the next
        // reconnect attempt fires.
        await new Promise((r) => setTimeout(r, 200));
      },
    });
    await this.client.connect();
  }

  close(): void {
    this.client?.close();
  }

  async status(): Promise<DaemonStatus | null> {
    if (!this.client) return null;
    return this.client.status();
  }

  isDaemonReachable(): boolean {
    return this.client?.isConnected() ?? false;
  }

  async openTab(url: string): Promise<number | undefined> {
    const msg = await this.client!.request({ cmd: "open-tab", url });
    return (msg as { tabId?: number }).tabId;
  }

  async closeTabs(tabIds: number[]): Promise<void> {
    await this.client!.request({ cmd: "close-tabs", tabIds });
  }

  async getTabList(): Promise<BrowserTab[]> {
    const msg = await this.client!.request({ cmd: "get-tab-list" });
    return (msg as { tabs: BrowserTab[] }).tabs;
  }

  async getBrowserRecentHistory(searchQuery?: string): Promise<BrowserHistoryItem[]> {
    const msg = await this.client!.request({
      cmd: "get-browser-recent-history",
      searchQuery,
    });
    return (msg as { historyItems: BrowserHistoryItem[] }).historyItems;
  }

  async getTabContent(tabId: number, offset: number): Promise<TabContentExtensionMessage> {
    const msg = await this.client!.request({ cmd: "get-tab-content", tabId, offset });
    return msg as TabContentExtensionMessage;
  }

  async reorderTabs(tabOrder: number[]): Promise<number[]> {
    const msg = await this.client!.request({ cmd: "reorder-tabs", tabOrder });
    return (msg as { tabOrder: number[] }).tabOrder;
  }

  async findHighlight(tabId: number, queryPhrase: string): Promise<number> {
    const msg = await this.client!.request({ cmd: "find-highlight", tabId, queryPhrase });
    return (msg as { noOfResults: number }).noOfResults;
  }

  async groupTabs(
    tabIds: number[],
    isCollapsed: boolean,
    groupColor: string,
    groupTitle: string
  ): Promise<number> {
    const msg = await this.client!.request({
      cmd: "group-tabs",
      tabIds,
      isCollapsed,
      groupColor,
      groupTitle,
    });
    return (msg as { groupId: number }).groupId;
  }
}
