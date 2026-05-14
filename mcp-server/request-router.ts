import * as crypto from "node:crypto";

export interface RouterClient {
  // Marker type — the actual client is whatever the daemon passes in
  // (typically a net.Socket). Router is intentionally not coupled to that.
}

interface Entry {
  client: RouterClient;
  clientCorrelationId: string;
  timer: NodeJS.Timeout;
}

export interface RequestRouterOptions {
  timeoutMs: number;
}

export class RequestRouter {
  private entries = new Map<string, Entry>();

  constructor(private readonly options: RequestRouterOptions) {}

  register(
    client: RouterClient,
    clientCorrelationId: string,
    onTimeout?: (daemonCorrelationId: string) => void
  ): string {
    const daemonCorrelationId = crypto.randomBytes(8).toString("hex");
    const timer = setTimeout(() => {
      if (this.entries.delete(daemonCorrelationId) && onTimeout) {
        onTimeout(daemonCorrelationId);
      }
    }, this.options.timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    this.entries.set(daemonCorrelationId, {
      client,
      clientCorrelationId,
      timer,
    });
    return daemonCorrelationId;
  }

  take(daemonCorrelationId: string): { client: RouterClient; clientCorrelationId: string } | undefined {
    const entry = this.entries.get(daemonCorrelationId);
    if (!entry) return undefined;
    clearTimeout(entry.timer);
    this.entries.delete(daemonCorrelationId);
    return { client: entry.client, clientCorrelationId: entry.clientCorrelationId };
  }

  forEachForClient(
    client: RouterClient,
    fn: (daemonCorrelationId: string, clientCorrelationId: string) => void
  ): void {
    for (const [daemonCid, entry] of this.entries) {
      if (entry.client === client) fn(daemonCid, entry.clientCorrelationId);
    }
  }

  dropClient(client: RouterClient): void {
    for (const [daemonCid, entry] of this.entries) {
      if (entry.client === client) {
        clearTimeout(entry.timer);
        this.entries.delete(daemonCid);
      }
    }
  }

  size(): number {
    return this.entries.size;
  }
}
