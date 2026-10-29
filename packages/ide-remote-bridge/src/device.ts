import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  type WebRemoteControlAppPayload,
  type WebRemoteControlWorkspaceTarget,
} from "../../shared/src/index.js";
import {
  connectViaProtocol,
  createAcknowledgedWebRemoteControlRelayProtocol,
  type AcknowledgedWebRemoteControlRelayProtocolAdapter,
} from "../../client/src/index.js";
import { WebRemoteControlDeviceTransport } from "../../desktop/src/main/web-remote-relay/webRemoteControlTransport.js";
import { createWebRemoteControlV2Http } from "../../desktop/src/main/web-remote-relay/webRemoteControlV2Http.js";
import { loadZcodeJwt } from "./credentials.js";
import { connectLocalServer, type LocalServerLink } from "./server-link.js";
import {
  dedupeWorkspacePaths,
  normalizeWorkspaceKey,
  resolveWorkspaceTarget,
} from "./workspace-keys.js";

export interface DeviceBridgeOptions {
  origin: string;
  relayWsUrl: string;
  serverBaseUrl: string;
  serverToken: string;
  /** 全 IDE 打开的所有项目；手机端可在这些工作区间切换。 */
  workspaces: string[];
  /** 当前窗口的项目，用于手机首次进入时的默认选中项。 */
  primaryWorkspacePath?: string;
  /** 当前窗口已经按 server identity 构造好的 workspaceIdentity；仅对 primary 生效。 */
  workspaceIdentity?: string;
  appVersion?: string;
  deviceName?: string;
  /** 插件自己的设备码；缺省时读 state file 或生成 `ide-<uuid>` 并持久化。 */
  deviceMid?: string;
  stateFile?: string;
  logger?: (message: string, detail?: unknown) => void;
}

interface BridgeState {
  bridgeSessionId: string;
  bridgeGeneration?: number;
  recoveryId?: string;
  adapter: AcknowledgedWebRemoteControlRelayProtocolAdapter;
  local: LocalServerLink;
  ready: boolean;
  dispose: () => void;
}

interface MobileViewState {
  activeWorkspaceKey?: string;
  activeTaskId?: string;
  updatedAt: number;
}

export interface DeviceBridgeStartResult {
  deviceSid: string;
  qrUrl: string;
}

/**
 * 插件侧 Web 远控 device：
 * 手机 /remote/v4 -> 官方 relay -> 本进程 -> 本地 ZCode server /ws。
 * relay 连接与 V2 状态机直接复用 desktop 的 WebRemoteControlDeviceTransport；
 * 本进程只补 bootstrap 与 RPC 帧转发，不持有任务业务状态。
 */
export class DeviceBridge {
  private readonly log: (message: string, detail?: unknown) => void;
  private deviceName: string;
  private deviceMid: string;
  private transport?: WebRemoteControlDeviceTransport;
  private bridge?: BridgeState;
  private deviceSid?: string;
  private stopped = false;
  private viewState?: MobileViewState;
  private readonly windowControlSessionId = randomUUID();
  private readonly mobileTaskViewEpoch = randomUUID();
  private readonly stateFile: string;
  private resolvedAppVersion?: string;
  private projectWorkspacesCache?: { at: number; paths: string[] };
  /** workspace-bridge-open 的串行队列：并发 open 时后一个必须等前一个完全建好（或失败）再动 this.bridge，否则先建立的本地连接与监听器会被覆盖泄漏。 */
  private openChain: Promise<void> = Promise.resolve();

  constructor(private readonly options: DeviceBridgeOptions) {
    this.log = options.logger ?? ((message) => console.log(`[ide-remote-bridge] ${message}`));
    this.deviceName = options.deviceName?.trim() || "";
    this.deviceMid = options.deviceMid?.trim() || "";
    this.stateFile =
      options.stateFile ?? join(homedir(), ".zcode", "v2", "ide-remote-device.json");
  }

  async start(): Promise<DeviceBridgeStartResult> {
    const jwt = loadZcodeJwt();
    const http = createWebRemoteControlV2Http(this.options.origin);
    const serverInfo = await this.readServerInfo();

    // 插件使用自己的设备身份，与桌面客户端完全分开：
    // - 手机端能同时看到 `host-a`（桌面）与 `host-a (IDE)`，并区分哪个端在线；
    // - 两端可以同时开启远控，不会互相把对方踢下线；
    // - deviceMid/deviceSid 持久化在 ~/.zcode/v2/ide-remote-device.json，链接长期稳定。
    const stored = this.readStoredState();
    this.deviceMid =
      this.options.deviceMid?.trim() || stored.deviceMid || `ide-${randomUUID()}`;
    this.deviceName = this.options.deviceName?.trim() || `${hostname()} (IDE)`;
    this.resolvedAppVersion = this.options.appVersion?.trim() || serverInfo.version;

    let resolveSid: (sid: string) => void = () => {};
    const sidReady = new Promise<string>((resolve) => {
      resolveSid = resolve;
    });
    const storedSid =
      !stored.deviceMid || stored.deviceMid === this.deviceMid ? stored.deviceSid : undefined;

    const transport = new WebRemoteControlDeviceTransport({
      relayWsUrl: this.options.relayWsUrl,
      deviceMid: this.deviceMid,
      meta: {
        name: this.deviceName,
        platform: process.platform,
        version: this.resolvedAppVersion,
      },
      getToken: (signal) => http.token(jwt, signal),
      resolveDeviceSid: async (signal, forceRegistration) => {
        if (storedSid && !forceRegistration) {
          this.deviceSid = storedSid;
          resolveSid(storedSid);
          return storedSid;
        }
        const sid = await http.register(this.deviceMid, jwt, signal);
        this.deviceSid = sid;
        this.writeStoredSid(sid);
        resolveSid(sid);
        return sid;
      },
      logger: {
        info: (message) => this.log(String(message)),
        warn: (message) => this.log(`WARN ${String(message)}`),
        error: (message) => this.log(`ERROR ${String(message)}`),
      },
      onStateChange: (state) => this.log(`relay state=${state}`),
      onPayload: (payload) =>
        // 兜底：bootstrap/workspace-list 失败时官方 app-payload 层没有 error 形态可回
        // （只有 success: true），只能记日志让手机端超时重试；但绝不能让异常变成
        // unhandled rejection——Node 24 默认会直接杀掉整个桥进程。
        void this.handleAppPayload(payload).catch((error) => {
          this.log(
            `ERROR app payload 处理失败: ${error instanceof Error ? error.message : String(error)}`,
          );
        }),
      onRawTransportPayload: (payload) => this.bridge?.adapter.acceptPayload(payload) ?? false,
      onRawTransportFault: (reasonCode) => this.log(`raw transport fault ${reasonCode}`),
      onError: (error) => this.log(`relay error ${error.message}`),
      onSendReady: () => this.bridge?.adapter.replayUnacknowledged(),
    });
    this.transport = transport;
    transport.start();

    const deviceSid = await Promise.race([
      sidReady,
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error("等待 relay 注册超时")), 20_000),
      ),
    ]);
    this.log(`device ${deviceSid} ready, mid=${this.deviceMid} name=${this.deviceName}`);
    return { deviceSid, qrUrl: this.buildQrUrl(deviceSid) };
  }

  stop(): void {
    this.stopped = true;
    this.disposeBridge();
    this.transport?.dispose();
    this.transport = undefined;
  }

  private buildQrUrl(deviceSid: string): string {
    const url = new URL(`${this.options.origin.replace(/\/+$/, "")}/remote/v4`);
    url.searchParams.set("sid", deviceSid);
    url.searchParams.set("mid", this.deviceMid);
    url.searchParams.set("name", this.deviceName);
    url.searchParams.set("app_version", this.resolvedAppVersion ?? "3.16.2");
    return url.toString();
  }

  private async handleAppPayload(payload: WebRemoteControlAppPayload): Promise<void> {
    if (!payload || typeof payload !== "object" || !("zcode_type" in payload)) return;
    switch (payload.zcode_type) {
      case "bootstrap-request":
        this.send({
          zcode_type: "bootstrap-response",
          requestId: payload.requestId,
          success: true,
          result: await this.buildBootstrapResult(),
        });
        return;
      case "workspace-list-request":
        this.send({
          zcode_type: "workspace-list-response",
          requestId: payload.requestId,
          success: true,
          result: { workspaces: await this.buildWorkspaceTargets() },
        });
        return;
      case "workspace-bridge-open":
        this.openChain = this.openChain
          .then(() => this.openWorkspaceBridge(payload))
          .catch((error) => {
            // openWorkspaceBridge 内部已全量兜底（失败会回 workspace-bridge-error），
            // 这里只是防止队列被意外毒化，让后续 open 还能继续。
            this.log(
              `ERROR workspace-bridge-open 调度失败: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
        return;
      case "workspace-reconnect-request":
        this.send({
          zcode_type: "workspace-reconnect-response",
          requestId: payload.requestId,
          workspaceKey: payload.workspaceKey,
          success: true,
        });
        return;
      case "mobile-view-state-update":
        this.viewState = { ...payload.viewState, updatedAt: Date.now() };
        return;
      case "platform-request":
        this.send({
          zcode_type: "platform-response",
          requestId: payload.requestId,
          method: payload.method,
          success: false,
          error: "该能力暂未在 IDE 插件中提供",
        });
        return;
      default:
        return;
    }
  }

  /**
   * 全 IDE 的 workspace 列表。
   *
   * `workspacePath` 直接使用 server 项目树里的原始写法，并作为手机端的 workspaceKey：
   * server 按字面字符串判定工作区，IDE 面板用的也是这个写法，两者一致才能复用同一个 agent。
   * 不填 `workspaceIdentity`——local 目标带 identity 会让手机端优先用 identity 当 key，
   * 而 server 并不认识这个身份串，等于又建了一个工作区。
   */
  private async buildWorkspaceTargets(): Promise<WebRemoteControlWorkspaceTarget[]> {
    const paths = await this.readProjectWorkspaces();
    return paths.map((workspacePath) => ({
      workspacePath,
      label: basename(workspacePath) || workspacePath,
      kind: "local" as const,
      connectionState: "connected" as const,
    }));
  }

  /**
   * 读取 ZCode 里添加的所有项目（与桌面客户端共用同一份 ~/.zcode 数据）。
   *
   * 用临时 RPC 连接调 `projectService.readTree()`；结果缓存 5 秒，避免手机每次刷新都建连接。
   * 失败时回退到 IDE 当前打开的项目，保证远控仍可用。
   */
  private async readProjectWorkspaces(): Promise<string[]> {
    const now = Date.now();
    if (this.projectWorkspacesCache && now - this.projectWorkspacesCache.at < 5_000) {
      return this.projectWorkspacesCache.paths;
    }
    let link: LocalServerLink | undefined;
    try {
      link = await connectLocalServer(
        `${this.options.serverBaseUrl.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(this.options.serverToken)}`,
      );
      const services = connectViaProtocol(link.protocol) as unknown as {
        projectService?: {
          readTree?: (params?: {
            includeDeleted?: boolean;
            includeDeletedTasks?: boolean;
          }) => Promise<{
            projects?: Array<{ roots?: Array<{ rootPath?: string }> }>;
          }>;
        };
      };
      const tree = await services.projectService?.readTree?.({ includeDeleted: false });
      // 保留 server 的原始写法（Windows 下是反斜杠），只按归一化结果去重；
      // 归一化后的路径仅用于比较，不能下发（见 workspace-keys.ts）。
      const paths = dedupeWorkspacePaths(
        (tree?.projects ?? [])
          .flatMap((project) => project.roots ?? [])
          .map((root) => root.rootPath ?? ""),
      );
      const primary = this.options.primaryWorkspacePath?.trim();
      if (
        primary &&
        !paths.some((path) => normalizeWorkspaceKey(path) === normalizeWorkspaceKey(primary))
      ) {
        paths.unshift(primary);
      }
      const result = paths.length > 0 ? paths : this.options.workspaces;
      this.projectWorkspacesCache = { at: now, paths: result };
      return result;
    } catch (error) {
      this.log(`read ZCode projects failed, fallback to IDE workspaces: ${String(error)}`);
      const primary = this.options.primaryWorkspacePath?.trim();
      const fallback = dedupeWorkspacePaths(this.options.workspaces);
      if (
        primary &&
        !fallback.some((path) => normalizeWorkspaceKey(path) === normalizeWorkspaceKey(primary))
      ) {
        fallback.unshift(primary);
      }
      return fallback;
    } finally {
      link?.close();
    }
  }

  private async buildBootstrapResult() {
    const workspaces = await this.buildWorkspaceTargets();
    const primary =
      resolveWorkspaceTarget(workspaces, this.options.primaryWorkspacePath) ?? workspaces[0];
    if (!primary) throw new Error("IDE 没有可用的项目目录");
    const initialViewState: MobileViewState = {
      activeWorkspaceKey: primary.workspacePath,
      updatedAt: Date.now(),
    };
    return {
      windowControlSessionId: this.windowControlSessionId,
      desktopAppVersion: this.resolvedAppVersion,
      workspaces,
      initialViewState,
      ...(this.viewState ? { mobileViewState: this.viewState } : {}),
      mobileTaskViewEpoch: this.mobileTaskViewEpoch,
    };
  }

  private async openWorkspaceBridge(
    request: Extract<WebRemoteControlAppPayload, { zcode_type: "workspace-bridge-open" }>,
  ): Promise<void> {
    try {
      if (this.stopped) throw new Error("bridge stopped");
      const workspaces = await this.buildWorkspaceTargets();
      const requestedKey = request.workspaceKey?.trim();
      const workspace = resolveWorkspaceTarget(workspaces, requestedKey);
      if (!workspace) throw new Error(`未知工作区: ${requestedKey}`);
      // key 一律用 server 的原始写法，不回声请求原值：server 按字面字符串派生 agent，
      // 手机回传的正斜杠写法会让同一个项目再起一套 agent。
      const workspaceKey = workspace.workspacePath;
      this.disposeBridge();
      const local = await connectLocalServer(
        `${this.options.serverBaseUrl.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(this.options.serverToken)}`,
      );
      const state: BridgeState = {
        bridgeSessionId: request.bridgeSessionId,
        bridgeGeneration: request.bridgeGeneration,
        recoveryId: request.recoveryId,
        adapter: undefined as unknown as AcknowledgedWebRemoteControlRelayProtocolAdapter,
        local,
        ready: false,
        dispose: () => {},
      };
      state.adapter = createAcknowledgedWebRemoteControlRelayProtocol({
        bridgeSessionId: request.bridgeSessionId,
        bridgeGeneration: request.bridgeGeneration,
        recoveryId: request.recoveryId,
        measureFrameBytes: (frame) =>
          this.transport?.measurePayloadBytes(frame as never) ?? 0,
        sendFrame: (frame) =>
          state.ready ? (this.transport?.sendPayload(frame as never) ?? false) : false,
      });
      const disposeLocalToRelay = local.protocol.onMessage((buffer) => {
        state.adapter.protocol.send(buffer);
      });
      const disposeRelayToLocal = state.adapter.protocol.onMessage((buffer) => {
        local.protocol.send(buffer);
      });
      const disposeDegraded = state.adapter.onDegraded((fault) => {
        this.log(`bridge degraded ${fault.reasonCode}`);
      });
      state.dispose = () => {
        disposeLocalToRelay.dispose();
        disposeRelayToLocal.dispose();
        disposeDegraded.dispose();
        state.adapter.dispose();
        local.close();
      };
      this.bridge = state;
      void local.closed.then(() => {
        if (this.bridge === state) this.bridge = undefined;
      });

      this.send({
        zcode_type: "workspace-bridge-ready",
        requestId: request.requestId,
        bridgeSessionId: request.bridgeSessionId,
        ...(request.bridgeGeneration !== undefined
          ? { bridgeGeneration: request.bridgeGeneration }
          : {}),
        ...(request.recoveryId ? { recoveryId: request.recoveryId } : {}),
        bridge: {
          bridgeSessionId: request.bridgeSessionId,
          ...(request.bridgeGeneration !== undefined
            ? { bridgeGeneration: request.bridgeGeneration }
            : {}),
          ...(request.recoveryId ? { recoveryId: request.recoveryId } : {}),
          kind: "local",
          workspaceKey,
          workspacePath: workspace.workspacePath,
          ...(request.taskId ? { initialTaskId: request.taskId } : {}),
        },
      });
      state.ready = true;
      state.adapter.flushPendingFrames();
      this.log(`bridge active ${request.bridgeSessionId} workspace=${workspaceKey}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`bridge open failed: ${message}`);
      this.send({
        zcode_type: "workspace-bridge-error",
        requestId: request.requestId,
        bridgeSessionId: request.bridgeSessionId,
        ...(request.bridgeGeneration !== undefined
          ? { bridgeGeneration: request.bridgeGeneration }
          : {}),
        ...(request.recoveryId ? { recoveryId: request.recoveryId } : {}),
        reason: "unexpected-error",
        error: message,
      });
    }
  }

  private disposeBridge(): void {
    const bridge = this.bridge;
    this.bridge = undefined;
    bridge?.dispose();
  }

  private send(payload: unknown): boolean {
    return this.transport?.sendPayload(payload as never) ?? false;
  }

  private async readServerInfo(): Promise<{ serverId: string; version: string }> {
    const response = await fetch(`${this.options.serverBaseUrl}/api/server-info`, {
      headers: { Authorization: `Bearer ${this.options.serverToken}` },
    });
    if (!response.ok) throw new Error(`server-info ${response.status}`);
    const info = (await response.json()) as { serverId?: string; version?: string };
    const serverId = info.serverId?.trim();
    if (!serverId) throw new Error("server-info 缺少 serverId");
    return { serverId, version: info.version?.trim() || "3.16.2" };
  }

  /** 读取插件自己的持久身份；与桌面客户端状态完全隔离。 */
  private readStoredState(): { deviceMid?: string; deviceSid?: string } {
    try {
      if (!existsSync(this.stateFile)) return {};
      const parsed = JSON.parse(readFileSync(this.stateFile, "utf8")) as {
        origin?: string;
        deviceMid?: string;
        deviceSid?: string;
      };
      if (parsed.origin !== this.options.origin) return {};
      return {
        deviceMid: parsed.deviceMid?.trim() || undefined,
        deviceSid: parsed.deviceSid?.trim() || undefined,
      };
    } catch {
      return {};
    }
  }

  private writeStoredSid(deviceSid: string): void {
    try {
      mkdirSync(dirname(this.stateFile), { recursive: true });
      writeFileSync(
        this.stateFile,
        JSON.stringify(
          { origin: this.options.origin, deviceMid: this.deviceMid, deviceSid },
          null,
          2,
        ),
      );
    } catch {
      // 缓存 sid 失败不影响远控，只是下次会重新注册设备
    }
  }
}
