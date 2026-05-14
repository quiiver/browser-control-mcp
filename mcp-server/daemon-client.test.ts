import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import type {
  HelloFrame,
  HelloAckFrame,
  RequestFrame,
  ResponseFrame,
} from "@browser-control-mcp/common";
import { PROTOCOL_VERSION } from "./daemon-handshake";
import { DaemonClient } from "./daemon-client";

function tmpSocketPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bcm-dc-"));
  return path.join(dir, "sock");
}

interface StubDaemon {
  socketPath: string;
  server: net.Server;
  onHello: ((sock: net.Socket, frame: HelloFrame) => void) | null;
  onRequest: ((sock: net.Socket, frame: RequestFrame) => void) | null;
  close: () => Promise<void>;
}

async function startStubDaemon(socketPath: string): Promise<StubDaemon> {
  const stub = {
    socketPath,
    server: null as any,
    onHello: null,
    onRequest: null,
    close: null as any,
  } as StubDaemon;
  stub.server = net.createServer((sock) => {
    let buf = "";
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const parsed = JSON.parse(line);
        if (parsed.type === "hello") stub.onHello?.(sock, parsed);
        else if (parsed.type === "request") stub.onRequest?.(sock, parsed);
      }
    });
  });
  stub.close = () =>
    new Promise<void>((resolve) => {
      stub.server.close(() => resolve());
    });
  return new Promise<StubDaemon>((resolve) => {
    stub.server.listen(socketPath, () => resolve(stub));
  });
}

test("connect + hello-ack + request/response round-trip", async () => {
  const sp = tmpSocketPath();
  const stub = await startStubDaemon(sp);
  stub.onHello = (sock) => {
    const ack: HelloAckFrame = {
      type: "hello-ack",
      protocolVersion: PROTOCOL_VERSION,
      daemonPid: 99999,
      daemonVersion: "1.7.0-stub",
    };
    sock.write(JSON.stringify(ack) + "\n");
  };
  stub.onRequest = (sock, frame) => {
    const resp: ResponseFrame = {
      type: "response",
      clientCorrelationId: frame.clientCorrelationId,
      ok: true,
      payload: {
        resource: "tabs",
        correlationId: "ignored",
        tabs: [{ id: 1, url: "https://example.com", title: "Example" } as any],
      } as any,
    };
    sock.write(JSON.stringify(resp) + "\n");
  };

  const client = new DaemonClient({
    socketPath: sp,
    secret: "any",
    clientVersion: "1.7.0-test",
    requestTimeoutMs: 1000,
    spawnDaemon: async () => {
      throw new Error("should not need to spawn — stub is running");
    },
  });
  await client.connect();
  const reply = await client.request({ cmd: "get-tab-list" });
  assert.equal((reply as any).resource, "tabs");
  await client.close();
  await stub.close();
});

test("request rejects on timeout if daemon never responds", async () => {
  const sp = tmpSocketPath();
  const stub = await startStubDaemon(sp);
  stub.onHello = (sock) => {
    const ack: HelloAckFrame = {
      type: "hello-ack",
      protocolVersion: PROTOCOL_VERSION,
      daemonPid: 1,
      daemonVersion: "1.7.0-stub",
    };
    sock.write(JSON.stringify(ack) + "\n");
  };
  // No onRequest handler — request will time out.

  const client = new DaemonClient({
    socketPath: sp,
    secret: "any",
    clientVersion: "1.7.0-test",
    requestTimeoutMs: 80,
    spawnDaemon: async () => {
      throw new Error("not needed");
    },
  });
  await client.connect();
  await assert.rejects(
    client.request({ cmd: "get-tab-list" }),
    /timed out|timeout/i
  );
  await client.close();
  await stub.close();
});

test("connect() invokes spawnDaemon when socket does not exist", async () => {
  const sp = path.join(os.tmpdir(), `bcm-spawn-${Date.now()}.sock`);
  let spawned = 0;
  let stubRef: StubDaemon | null = null;
  const client = new DaemonClient({
    socketPath: sp,
    secret: "any",
    clientVersion: "1.7.0-test",
    requestTimeoutMs: 1000,
    spawnDaemon: async () => {
      spawned++;
      const stub = await startStubDaemon(sp);
      stub.onHello = (sock) => {
        const ack: HelloAckFrame = {
          type: "hello-ack",
          protocolVersion: PROTOCOL_VERSION,
          daemonPid: 2,
          daemonVersion: "1.7.0-stub",
        };
        sock.write(JSON.stringify(ack) + "\n");
      };
      stubRef = stub;
    },
  });
  await client.connect();
  assert.equal(spawned, 1);
  await client.close();
  await stubRef!.close();
});
