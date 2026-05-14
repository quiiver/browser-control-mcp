import * as crypto from "node:crypto";
import type { HelloFrame } from "@browser-control-mcp/common";

export const PROTOCOL_VERSION = 1;

export interface HelloAuthPayload {
  protocolVersion: number;
  clientPid: number;
  clientVersion: string;
  nonce: string;
}

export function computeHelloAuth(secret: string, payload: HelloAuthPayload): string {
  const canonical = JSON.stringify(payload);
  return crypto.createHmac("sha256", secret).update(canonical).digest("hex");
}

export function verifyHelloAuth(secret: string, frame: HelloFrame): boolean {
  const expected = computeHelloAuth(secret, {
    protocolVersion: frame.protocolVersion,
    clientPid: frame.clientPid,
    clientVersion: frame.clientVersion,
    nonce: frame.nonce,
  });
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(frame.auth));
}
