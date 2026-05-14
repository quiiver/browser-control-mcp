import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import type {
  HelloFrame,
  HelloAckFrame,
  ErrorFrame,
  RequestFrame,
  ResponseFrame,
} from "@browser-control-mcp/common";
import { PROTOCOL_VERSION, computeHelloAuth } from "./daemon-handshake";
import { IpcServer } from "./ipc-server";

function tmpSocketPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bcm-ipc-"));
  return path.join(dir, "sock");
}

function makeHello(secret: string): HelloFrame {
  const payload = {
    protocolVersion: PROTOCOL_VERSION,
    clientPid: process.pid,
    clientVersion: "1.7.0-test",
    nonce: crypto.randomBytes(16).toString("hex"),
  };
  return { type: "hello", ...payload, auth: computeHelloAuth(secret, payload) };
}

function readFrames(socket: net.Socket): { next: () => Promise<any> } {
  let buf = "";
  const queue: any[] = [];
  const waiters: ((v: any) => void)[] = [];
  socket.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const parsed = JSON.parse(line);
      const w = waiters.shift();
      if (w) w(parsed);
      else queue.push(parsed);
    }
  });
  return {
    next: () =>
      new Promise((resolve) => {
        if (queue.length) resolve(queue.shift());
        else waiters.push(resolve);
      }),
  };
}

test("hello-ack round-trip succeeds with valid HMAC", async () => {
  const secret = "test-secret";
  const sp = tmpSocketPath();
  const server = new IpcServer(secret, "1.7.0-daemon", {
    onRequest: () => {},
    onClientDisconnect: () => {},
    getStatus: () => ({} as any),
  });
  await server.start(sp);

  const client = net.createConnection(sp);
  await new Promise((r) => client.once("connect", r));
  const reader = readFrames(client);
  client.write(JSON.stringify(makeHello(secret)) + "\n");
  const ack = (await reader.next()) as HelloAckFrame;
  assert.equal(ack.type, "hello-ack");
  assert.equal(ack.protocolVersion, PROTOCOL_VERSION);
  assert.equal(ack.daemonVersion, "1.7.0-daemon");

  client.end();
  server.close();
});

test("bad HMAC is rejected with fatal error and socket closes", async () => {
  const sp = tmpSocketPath();
  const server = new IpcServer("real-secret", "1.7.0-daemon", {
    onRequest: () => {},
    onClientDisconnect: () => {},
    getStatus: () => ({} as any),
  });
  await server.start(sp);

  const client = net.createConnection(sp);
  await new Promise((r) => client.once("connect", r));
  const reader = readFrames(client);
  client.write(JSON.stringify(makeHello("wrong-secret")) + "\n");
  const err = (await reader.next()) as ErrorFrame;
  assert.equal(err.type, "error");
  assert.equal(err.fatal, true);
  assert.match(err.error, /auth/i);

  await new Promise((r) => client.once("close", r));
  server.close();
});

test("request before hello is rejected", async () => {
  const sp = tmpSocketPath();
  const server = new IpcServer("s", "1.7.0-daemon", {
    onRequest: () => {},
    onClientDisconnect: () => {},
    getStatus: () => ({} as any),
  });
  await server.start(sp);

  const client = net.createConnection(sp);
  await new Promise((r) => client.once("connect", r));
  const reader = readFrames(client);
  const req: RequestFrame = {
    type: "request",
    clientCorrelationId: "x",
    message: { cmd: "get-tab-list" },
  };
  client.write(JSON.stringify(req) + "\n");
  const err = (await reader.next()) as ErrorFrame;
  assert.equal(err.type, "error");
  assert.equal(err.fatal, true);

  server.close();
});

test("request after hello is forwarded; response written back", async () => {
  const sp = tmpSocketPath();
  const secret = "s";
  let captured: { client: net.Socket; frame: RequestFrame } | null = null;
  const server = new IpcServer(secret, "1.7.0-daemon", {
    onRequest: (c, f) => {
      captured = { client: c, frame: f };
    },
    onClientDisconnect: () => {},
    getStatus: () => ({} as any),
  });
  await server.start(sp);

  const client = net.createConnection(sp);
  await new Promise((r) => client.once("connect", r));
  const reader = readFrames(client);
  client.write(JSON.stringify(makeHello(secret)) + "\n");
  await reader.next(); // hello-ack

  const req: RequestFrame = {
    type: "request",
    clientCorrelationId: "abc",
    message: { cmd: "get-tab-list" },
  };
  client.write(JSON.stringify(req) + "\n");

  await new Promise((r) => setTimeout(r, 30));
  assert.ok(captured);
  assert.equal(captured!.frame.clientCorrelationId, "abc");

  const resp: ResponseFrame = {
    type: "response",
    clientCorrelationId: "abc",
    ok: true,
    payload: { resource: "tabs", correlationId: "ignored", tabs: [] } as any,
  };
  server.sendResponse(captured!.client, resp);
  const got = (await reader.next()) as ResponseFrame;
  assert.equal(got.type, "response");
  assert.equal(got.clientCorrelationId, "abc");
  assert.equal(got.ok, true);

  server.close();
});
