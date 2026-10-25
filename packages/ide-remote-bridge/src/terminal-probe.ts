import { randomUUID } from "node:crypto";
import {
  createAcknowledgedWebRemoteControlRelayProtocol,
  connectViaProtocol,
  type AcknowledgedWebRemoteControlRelayProtocolAdapter,
} from "../../client/src/index.js";
import { WebRemoteControlDeviceTransport } from "../../desktop/src/main/web-remote-relay/webRemoteControlTransport.js";
import { loadZcodeJwt } from "./credentials.js";

export interface TerminalProbeOptions {
  origin: string;
  relayWsUrl: string;
  deviceSid: string;
  deviceMid: string;
  timeoutMs?: number;
}

async function fetchTerminalToken(
  origin: string,
  jwt: string,
  signal: AbortSignal,
): Promise<string> {
  const response = await fetch(new URL("/api/v1/remote/token", origin), {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify({ role: "terminal" }),
    signal,
  });
  if (!response.ok) throw new Error(`terminal token HTTP ${response.status}`);
  const body = (await response.json()) as { code: number; data?: { token?: string } };
  if (body.code !== 0 || !body.data?.token) throw new Error("terminal token 响应无效");
  return body.data.token;
}

function waitFor<T>(
  pending: Map<string, (value: T) => void>,
  requestId: string,
  timeoutMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`等待响应超时: ${requestId}`));
    }, timeoutMs);
    pending.set(requestId, (value) => {
      clearTimeout(timer);
      pending.delete(requestId);
      resolve(value);
    });
  });
}

/** 模拟手机 /remote/v4：验证配对、bootstrap、bridge 与 RPC 帧转发。 */
export async function runTerminalProbe(options: TerminalProbeOptions): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const jwt = loadZcodeJwt();
  const pending = new Map<string, (value: Record<string, any>) => void>();
  let adapter: AcknowledgedWebRemoteControlRelayProtocolAdapter | undefined;
  let pairedResolve: (() => void) | undefined;
  const paired = new Promise<void>((resolve) => {
    pairedResolve = resolve;
  });

  const transport = new WebRemoteControlDeviceTransport({
    relayWsUrl: options.relayWsUrl,
    deviceMid: options.deviceMid,
    meta: { name: "ide-bridge-probe", platform: process.platform, version: "0.0.0" },
    getToken: (signal) => fetchTerminalToken(options.origin, jwt, signal),
    resolveDeviceSid: async () => options.deviceSid,
    logger: {
      info: (message) => console.log(`[probe] ${String(message)}`),
      warn: (message) => console.log(`[probe] WARN ${String(message)}`),
      error: (message) => console.log(`[probe] ERROR ${String(message)}`),
    },
    onStateChange: (state) => {
      console.log(`[probe] state=${state}`);
      if (state === "paired") pairedResolve?.();
    },
    onPayload: (payload) => {
      const value = payload as { zcode_type?: string; requestId?: string };
      if (value?.requestId && pending.has(value.requestId)) {
        pending.get(value.requestId)?.(payload as Record<string, any>);
      }
      console.log(`[probe] <- ${value?.zcode_type}`);
    },
    onRawTransportPayload: (payload) => adapter?.acceptPayload(payload) ?? false,
    onError: (error) => console.log(`[probe] error ${error.message}`),
  });
  transport.start();
  await Promise.race([
    paired,
    new Promise((_, reject) => setTimeout(() => reject(new Error("配对超时")), timeoutMs)),
  ]);

  const bootstrapId = `bootstrap-${randomUUID()}`;
  const bootstrapPromise = waitFor(pending, bootstrapId, timeoutMs);
  transport.sendPayload({ zcode_type: "bootstrap-request", requestId: bootstrapId });
  const bootstrap = await bootstrapPromise;
  console.log("[probe] bootstrap:", JSON.stringify(bootstrap.result));

  const listId = `list-${randomUUID()}`;
  const listPromise = waitFor(pending, listId, timeoutMs);
  transport.sendPayload({ zcode_type: "workspace-list-request", requestId: listId });
  const list = await listPromise;
  console.log("[probe] workspaces:", JSON.stringify(list.result));

  const bridgeSessionId = `probe-bridge-${randomUUID()}`;
  const openId = `open-${randomUUID()}`;
  const openPromise = waitFor(pending, openId, timeoutMs);
  // 手机端点击对话时可能用任务路径（正/反斜杠）而不是 identity 作为 workspaceKey。
  // 列表不再下发 identity：local 工作区带 identity 会让手机端优先用身份串当 key，
  // 而 server 只认原始路径，会多派生一个 agent。
  const workspaceKey =
    process.env["PROBE_WORKSPACE_KEY"] ?? list.result.workspaces[0].workspacePath;
  transport.sendPayload({
    zcode_type: "workspace-bridge-open",
    requestId: openId,
    bridgeSessionId,
    workspaceKey,
  });
  const ready = await openPromise;
  if (!ready.bridge) throw new Error(`bridge 建立失败: ${JSON.stringify(ready)}`);
  console.log("[probe] bridge ready:", JSON.stringify(ready.bridge));

  adapter = createAcknowledgedWebRemoteControlRelayProtocol({
    bridgeSessionId,
    measureFrameBytes: (frame) => transport.measurePayloadBytes(frame as never),
    sendFrame: (frame) => transport.sendPayload(frame as never),
  });
  adapter.flushPendingFrames();
  const services = connectViaProtocol(adapter.protocol);
  const settings = await (services as any).settingService.get();
  console.log("[probe] RPC OK, settings keys:", Object.keys(settings ?? {}).slice(0, 10));

  adapter.dispose();
  transport.dispose();
  console.log("[probe] done");
}
