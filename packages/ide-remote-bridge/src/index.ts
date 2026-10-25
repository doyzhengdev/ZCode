import { DeviceBridge } from "./device.js";
import { runTerminalProbe } from "./terminal-probe.js";

function arg(name: string, fallback?: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const role = arg("role", "device")!;
const origin = arg("origin", "https://zcode.z.ai")!;
const relayWsUrl = arg("relay-ws", "wss://zcode.z.ai/api/v1/remote/ws2")!;
const appVersion = arg("app-version");

if (role === "terminal") {
  const deviceSid = arg("device-sid");
  const deviceMid = arg("device-mid");
  if (!deviceSid || !deviceMid) throw new Error("terminal 模式需要 --device-sid 与 --device-mid");
  await runTerminalProbe({ origin, relayWsUrl, deviceSid, deviceMid });
} else {
  const serverUrl = arg("server-url");
  const serverToken = arg("server-token");
  const workspaces = process.argv
    .filter((value) => value.startsWith("--workspace="))
    .map((value) => value.slice("--workspace=".length).trim())
    .filter(Boolean);
  if (!serverUrl || !serverToken || workspaces.length === 0) {
    throw new Error("device 模式需要 --server-url、--server-token、至少一个 --workspace");
  }
  const bridge = new DeviceBridge({
    origin,
    relayWsUrl,
    serverBaseUrl: serverUrl,
    serverToken,
    workspaces,
    primaryWorkspacePath: arg("primary-workspace") ?? workspaces[0],
    workspaceIdentity: arg("workspace-identity"),
    appVersion,
    deviceMid: arg("device-mid"),
    stateFile: arg("state-file"),
    logger: (message, detail) =>
      console.error(`[device] ${message}`, detail === undefined ? "" : detail),
  });
  let result: Awaited<ReturnType<DeviceBridge["start"]>>;
  try {
    result = await bridge.start();
  } catch (error) {
    // stdout 是 IDE 侧唯一的结构化通道：失败原因也要走这里，否则 UI 只能看到“进程已退出”。
    console.log(
      JSON.stringify({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exit(1);
  }
  // stdout 只输出一行机器可读的 ready 结果，IDE 侧据此拿到二维码；日志全部走 stderr。
  console.log(
    JSON.stringify({ type: "ready", deviceSid: result.deviceSid, qrUrl: result.qrUrl }),
  );
  process.on("SIGINT", () => {
    bridge.stop();
    process.exit(0);
  });
  await new Promise(() => {});
}
