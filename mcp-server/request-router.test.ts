import { test } from "node:test";
import * as assert from "node:assert/strict";
import { RequestRouter } from "./request-router";

test("register + resolve round-trip", () => {
  const router = new RequestRouter({ timeoutMs: 1000 });
  const fakeClient = { id: "c1" };
  const daemonCid = router.register(fakeClient as any, "client-cid-1");
  assert.equal(typeof daemonCid, "string");
  const entry = router.take(daemonCid);
  assert.ok(entry);
  assert.equal(entry!.client, fakeClient);
  assert.equal(entry!.clientCorrelationId, "client-cid-1");
});

test("take() consumes (second take returns undefined)", () => {
  const router = new RequestRouter({ timeoutMs: 1000 });
  const id = router.register({} as any, "cid");
  router.take(id);
  assert.equal(router.take(id), undefined);
});

test("timeout removes entry and invokes onTimeout", () => {
  return new Promise<void>((resolve) => {
    const router = new RequestRouter({ timeoutMs: 30 });
    const timedOut: string[] = [];
    const id = router.register({} as any, "cid-timeout", (daemonCid) => {
      timedOut.push(daemonCid);
    });
    setTimeout(() => {
      assert.equal(router.take(id), undefined);
      assert.deepEqual(timedOut, [id]);
      resolve();
    }, 80);
  });
});

test("forEachForClient + dropClient", () => {
  const router = new RequestRouter({ timeoutMs: 1000 });
  const a = { id: "a" };
  const b = { id: "b" };
  router.register(a as any, "a1");
  router.register(a as any, "a2");
  router.register(b as any, "b1");

  const aIds: string[] = [];
  router.forEachForClient(a as any, (daemonCid, clientCid) => {
    aIds.push(clientCid);
  });
  assert.deepEqual(aIds.sort(), ["a1", "a2"]);

  router.dropClient(a as any);
  const remaining: string[] = [];
  router.forEachForClient(a as any, (_d, c) => remaining.push(c));
  assert.deepEqual(remaining, []);
  router.forEachForClient(b as any, (_d, c) => remaining.push(c));
  assert.deepEqual(remaining, ["b1"]);
});
