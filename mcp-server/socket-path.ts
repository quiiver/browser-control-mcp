import * as os from "node:os";
import * as path from "node:path";

export function resolveSocketPath(): string {
  if (process.env.BROWSER_CONTROL_SOCKET) {
    return process.env.BROWSER_CONTROL_SOCKET;
  }
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\browser-control-mcp`;
  }
  return path.join(os.homedir(), ".browser-control-mcp", "sock");
}
