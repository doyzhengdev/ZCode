import {
  createLocalServices,
  createTopicResourcePeers,
  getAppConfigDir,
} from "@zcode/services/node";
import {
  materializeBundledZCodeBuiltinProviderConfig,
  readBundledZCodeBuiltinProviderConfig,
} from "./bundledZCodeBuiltinProviderConfig.js";
import { createHttpServer, resolveHttpServerId } from "./http.js";
import { normalizeLegacyRemoteTasks } from "./legacy-remote-tasks.js";

async function main(): Promise<void> {
  const zcodeBuiltinProviderConfigFilePath = await materializeBundledZCodeBuiltinProviderConfig({
    environmentConfigRoot: getAppConfigDir(),
    content: readBundledZCodeBuiltinProviderConfig(),
  });
  const port = Number(process.env["PORT"]) || 3030;
  const host = process.env["ZCODE_SERVER_HOST"]?.trim() || process.env["HOST"]?.trim() || undefined;
  const staticRoot = process.env["ZCODE_WEB_STATIC_ROOT"]?.trim() || undefined;
  const authToken = process.env["ZCODE_SERVER_AUTH_TOKEN"]?.trim() || undefined;
  const topicResourcePeers = createTopicResourcePeers();
  const serverId = resolveHttpServerId();
  // local 宿主形态：不传 projectStorageHostId / serviceAuthorityMode，任务与项目直接
  // 归属 ownerHostId="local"，与桌面客户端共享同一套本地数据；此前 remote:server:<id>
  // 的隔离身份由 createServerHostServices 构造，独立 server 不再走那条装配。
  const services = createLocalServices({
    topicResourceRelayChannel: (request) => topicResourcePeers.getChannel(request),
    zcodeBuiltinProviderConfigFilePath,
    providerProvisioningTargetEnabled: Boolean(authToken),
  });

  // local 形态下本函数只对历史数据生效：修掉旧版本插件写入的、缺少 workspaceIdentity
  // 的 remote:server:<id> 任务行；新写入的任务不再产生 remote 身份。
  const workspace = process.env["ZCODE_SERVER_WORKSPACE"]?.trim();
  if (workspace) {
    try {
      const normalized = normalizeLegacyRemoteTasks(serverId, workspace);
      if (normalized > 0) {
        console.log(`[zcode-server:http] normalized ${normalized} legacy task row(s)`);
      }
    } catch (error) {
      console.error("[zcode-server:http] legacy task normalization failed", error);
    }
  }

  createHttpServer(services, port, {
    serverId,
    topicResourcePeers,
    ...(host ? { host } : {}),
    ...(staticRoot ? { staticRoot, spaFallback: true } : {}),
    ...(authToken ? { authToken, authRequired: true } : {}),
  });
}

void main().catch((error: unknown) => {
  console.error("[zcode-server:http] startup failed", error);
  process.exitCode = 1;
});
