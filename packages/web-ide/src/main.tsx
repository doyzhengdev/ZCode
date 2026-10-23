/**
 * ZCode IDE 版 Web 入口。
 *
 * 与 packages/web 的差别只有两点：
 * 1. 平台能力换成 IDE 版（本机文件对话框走 JCEF 桥，不用服务端目录浏览器）；
 * 2. 不启用远程工作区 / 内置浏览器 / 分享路由。
 * UI 本身完全是官方 @zcode/ui 的 Root。
 */
import { createRoot } from "react-dom/client";
import {
  AppErrorBoundary,
  Root,
  ZCodeIntlProvider,
  bindRemoteWorkspacePath,
  registerBaseWorkspaceServices,
  registerRemoteWorkspaceSession,
  useRemoteWorkspaceSessionStore,
} from "@zcode/ui";
import { connectViaWebSocket } from "@zcode/client";
import { buildServerRemoteWorkspaceIdentity } from "@zcode/shared";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { createIdePlatform } from "./idePlatform.js";
import { installIdeBridge } from "./ideBridge.js";
import { installIdeContextPush } from "./ideContextPush.js";
import "./styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("#root not found");
const root = createRoot(container);

function resolveWsUrl(): string {
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${window.location.host}/ws`;
}

async function readInitialWorkspace(): Promise<{
  path?: string;
  identity?: string;
}> {
  const params = new URLSearchParams(window.location.search);
  const override = params.get("ideWorkspace")?.trim();
  try {
    const response = await fetch("/api/server-info", { cache: "no-store" });
    if (!response.ok) return override ? { path: override } : {};
    const info = (await response.json()) as {
      serverId?: string;
      workspaces?: Array<{ path?: string; workspaceIdentity?: string }>;
    };
    const workspace = info.workspaces?.[0];
    const path = workspace?.path ?? override;
    // UI 用 workspaceIdentity 推导 hostId（分组/项目归属）。独立 server 的 host 是
    // remote:server:<serverId>，不传 identity 会退回 "local" 并触发 host-identity-mismatch。
    const identity =
      workspace?.workspaceIdentity ??
      (info.serverId && path
        ? buildServerRemoteWorkspaceIdentity({ serverId: info.serverId, workspacePath: path })
        : undefined);
    return { path, identity };
  } catch {
    return override ? { path: override } : {};
  }
}

function renderFatal(error: unknown): void {
  const message = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
  container!.innerHTML = `
    <div style="font:13px/1.6 ui-monospace,Consolas,monospace;color:#e6e6e6;background:#151718;padding:24px;height:100%;box-sizing:border-box;white-space:pre-wrap">
      <div style="color:#ff7b72;font-weight:600;margin-bottom:12px">ZCode IDE 前端启动失败</div>
      <div>${message.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!)}</div>
    </div>`;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * 独立 server 模式下 UI 的“新建项目”会传 hostId=local，而 server 的 ownerHostId
 * 是 remote:server:<id>，两者不匹配会报 project.host-offline。这里绕开该入口：
 * 启动时若工作区还没有项目，直接用不带 hostId 的 saveProject 落库（服务端会自动补
 * 正确的 hostId），并把草稿绑定到该项目。
 */
async function bindWorkspaceProject(
  services: Awaited<ReturnType<typeof connectViaWebSocket>>,
  workspacePath: string | undefined,
): Promise<{ projectId: string; canonicalPath: string } | null> {
  const projectService = services.projectService;
  if (!projectService || !workspacePath) return null;
  try {
    const tree = await projectService.readTree();
    const target = normalizePath(workspacePath);
    const existing = tree.projects.find((project) =>
      project.roots.some((root) => normalizePath(root.rootPath) === target),
    );
    const pickRoot = (roots: Array<{ rootPath: string; isPrimary: boolean }>) =>
      (roots.find((root) => root.isPrimary) ?? roots[0])?.rootPath;
    if (existing) {
      return { projectId: existing.id, canonicalPath: pickRoot(existing.roots) ?? workspacePath };
    }
    const name = workspacePath.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "workspace";
    const saved = await projectService.saveProject({ name, roots: [workspacePath] });
    // 发送前 server 会用 project.roots[0].rootPath 与工作区路径做严格字符串比较，
    // 必须让客户端后续都使用服务端规范化后的路径（Windows 下是反斜杠）。
    return { projectId: saved.id, canonicalPath: pickRoot(saved.roots) ?? workspacePath };
  } catch (error) {
    console.warn("[web-ide] project bootstrap failed", error);
    return null;
  }
}

async function bootstrap(): Promise<void> {
  installIdeBridge();
  let pushWorkspace: { path?: string; identity?: string } = {};
  // IDE → Web 推送（右键菜单发送文件引用等）；工作区路径在下面解析出来后经闭包读取。
  installIdeContextPush(() => pushWorkspace);
  const [services, initialWorkspace] = await Promise.all([
    connectViaWebSocket(resolveWsUrl(), { onClose: () => {} }),
    readInitialWorkspace(),
  ]);
  const platform = createIdePlatform();
  document.title = "ZCode - IDE";

  // 插件按 IDE 语言注入 ideLocale；localePreference=system 时用它代替 navigator.language。
  const localeParam = new URLSearchParams(window.location.search).get("ideLocale");
  const ideLocale: "zh-CN" | "en-US" | undefined =
    localeParam === "zh-CN" || localeParam === "en-US" ? localeParam : undefined;

  // 开发期调试钩子：只在 ?ideDebug=1 时暴露服务对象，便于在浏览器里验证 RPC。
  if (new URLSearchParams(window.location.search).get("ideDebug") === "1") {
    (window as unknown as Record<string, unknown>).__zcodeServices = services;
  }

  // 先确定项目与规范化路径，再渲染 Root：会话 cwd 必须与 project.roots[0] 完全一致。
  const bootstrapProject = await bindWorkspaceProject(services, initialWorkspace.path);
  const workspacePath = bootstrapProject?.canonicalPath ?? initialWorkspace.path;
  const workspaceIdentity = initialWorkspace.identity;
  pushWorkspace = { path: workspacePath, identity: workspaceIdentity };

  // 独立 server 的工作区从 UI 视角是 remote:server:<id>。官方流程由
  // RemoteWorkspaceController 建立连接并注册 attachment；IDE 版直接连接同一个 server，
  // 这里补一个等价 session，否则 rpcReady 恒为 false，所有会话都显示“设备未连接”。
  if (workspacePath && workspaceIdentity) {
    const sessionId = `ide-local:${workspaceIdentity}`;
    registerBaseWorkspaceServices(services);
    registerRemoteWorkspaceSession({
      sessionId,
      workspacePath,
      workspaceIdentity,
      services,
    });
    useRemoteWorkspaceSessionStore
      .getState()
      .bindWorkspaceIdentity(workspaceIdentity, sessionId);
    bindRemoteWorkspacePath(workspacePath, sessionId);
  }

  root.render(
    <AppErrorBoundary>
      <ZCodeIntlProvider
        settingService={services.settingService}
        broadcastService={services.broadcastService}
        initialLocale={ideLocale}
        resolveSystemLocale={() => ideLocale ?? "en-US"}
      >
        <Root
          services={services}
          platform={platform}
          initialWorkspaceAbsPath={workspacePath}
          initialWorkspaceIdentity={workspaceIdentity}
          supportsSettings
          allowOpenWorkspace
          preferDirectoryBrowser={false}
          supportsEmbeddedBrowser={false}
          allowRemoteWorkspace={false}
          isDesktop={false}
        />
      </ZCodeIntlProvider>
    </AppErrorBoundary>,
  );

  // Root 的首屏 effect 会先建立 workspace tab；项目绑定放在其后，避免被覆盖。
  if (bootstrapProject && workspacePath) {
    const projectId = bootstrapProject.projectId;
    const boundPath = workspacePath;
    window.setTimeout(() => {
      try {
        useZCodeSessionStore
          .getState()
          .startDraft(boundPath, undefined, workspaceIdentity, { projectId });
        console.info("[web-ide] draft bound to project", projectId);
      } catch (error) {
        console.warn("[web-ide] bind draft failed", error);
      }
    }, 1500);
  }
}

void bootstrap().catch(renderFatal);
