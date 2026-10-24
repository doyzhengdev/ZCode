/**
 * ZCode IDE 版 Web 入口。
 *
 * 与 packages/web 的差别只有两点：
 * 1. 平台能力换成 IDE 版（本机文件对话框走 JCEF 桥，不用服务端目录浏览器）；
 * 2. 不启用远程工作区 / 内置浏览器 / 分享路由。
 * UI 本身完全是官方 @zcode/ui 的 Root。
 */
import { createRoot } from "react-dom/client";
import { AppErrorBoundary, Root, ZCodeIntlProvider } from "@zcode/ui";
import { connectViaWebSocket } from "@zcode/client";
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
  // IDE 显式指定的项目优先：全 IDE 共用一个 server，server-info 的 workspaces[0] 只是
  // server 的默认工作区，对其他项目的窗口是错的。identity 保持空（local 宿主形态）。
  if (override) return { path: override };
  try {
    const response = await fetch("/api/server-info", { cache: "no-store" });
    if (!response.ok) return {};
    const info = (await response.json()) as {
      serverId?: string;
      workspaces?: Array<{ path?: string; workspaceIdentity?: string }>;
    };
    const workspace = info.workspaces?.[0];
    // local 宿主形态下 UI 直连本地 server，与桌面客户端共用 "local" 身份，无需构造
    // remote 身份；server-info 返回什么 workspaceIdentity 就用什么（通常为空）。
    return {
      path: workspace?.path,
      identity: workspace?.workspaceIdentity ?? undefined,
    };
  } catch {
    return {};
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

type ServiceAccessor = Awaited<ReturnType<typeof connectViaWebSocket>>;

/**
 * IDE 宿主是单窗口形态：桌面端的窗口 Host 由 Electron 主进程注册 `window-controller` 通道，
 * 独立 server 没有该通道。代理对象本身存在，所以 UI 的 `controller ? … : …` 判断会走错分支，
 * 归档/置顶发出 `controller.mutateTask` 后得到 "Unknown channel: window-controller"，
 * 侧栏提示「归档任务失败」。屏蔽后这些命令统一回落到 zcodeTaskService。
 */
function forIdeHost(services: ServiceAccessor): ServiceAccessor {
  return new Proxy(services, {
    get(target, property) {
      if (property === "windowControllerService") return undefined;
      return Reflect.get(target, property, target);
    },
  });
}

/**
 * 启动时确保工作区已有项目并把草稿绑定到它：local 形态下 UI 新建项目传的 hostId=local
 * 与 server 的 ownerHostId 一致，可直接落库；仍用不带 hostId 的 saveProject 由服务端
 * 自动补齐，路径以服务端规范化结果为准（Windows 下是反斜杠）。
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
    connectViaWebSocket(resolveWsUrl(), { onClose: () => {} }).then(forIdeHost),
    readInitialWorkspace(),
  ]);
  // MCP 用户目录读写走本机 server 的 mcpSyncService（桌面端对应能力在 Electron 主进程）。
  const platform = createIdePlatform(services);
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
  pushWorkspace = { path: workspacePath };

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
          supportsSettings
          allowOpenWorkspace
          preferDirectoryBrowser={false}
          supportsEmbeddedBrowser={false}
          allowRemoteWorkspace={false}
          // 不伪装桌面：窗口控制、托盘、自动更新、电源、剪贴板这些本来就该由 IDE 承担，
          // 置 isDesktop=true 只会把它们和桌面窗口框架一起画进 JCEF，还得再逐项裁剪。
          // 真正需要的本机数据能力（MCP 用户目录）已在 idePlatform.ts 里按能力补齐。
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
          // local 形态没有 workspaceIdentity，第三参保持位置传 undefined。
          .startDraft(boundPath, undefined, undefined, { projectId });
        console.info("[web-ide] draft bound to project", projectId);
      } catch (error) {
        console.warn("[web-ide] bind draft failed", error);
      }
    }, 1500);
  }
}

void bootstrap().catch(renderFatal);
