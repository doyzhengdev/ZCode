// IDE 插件侧补充用例：旧版本把 Windows 盘符路径以 identity 归一形态（"/E:/x"）写入会话，
// 修复器需要把它还原为 "E:/x"。用例随 IDE 补丁迁移到独立文件（官方测试文件保持上游原状），
// helper 与官方文件内的同名 helper 保持一致，改官方 helper 时需人工同步。
import { describe, expect, it, vi } from "vitest";
import {
  createProjectId,
  createSessionId,
  type SessionInfo,
  type SessionStorePort,
  type UpdateSessionInput,
  type WorkspaceId,
} from "@zcode/contracts";
import {
  repairPersistedRemoteSessionPaths,
} from "../src/runtime/helpers/persisted-remote-session-path-repair.js";

function createSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: createSessionId("remote-path-repair"),
    projectID: createProjectId("remote-path-repair"),
    workspaceID: "remote:wsl:Debian:dev:/home/dev/project" as WorkspaceId,
    taskType: "interactive",
    slug: "remote-path-repair",
    directory: "/home/dev/project",
    path: "/home/dev/project",
    title: "Remote path repair",
    version: "0.1.0",
    time: { created: 1, updated: 1 },
    ...overrides,
  };
}

function createUpdater(session: SessionInfo) {
  let persisted = session;
  const updateSession = vi.fn(
    async (input: UpdateSessionInput): Promise<SessionInfo> => ({
      ...session,
      ...(input.directory !== undefined ? { directory: input.directory } : {}),
      ...(input.path !== undefined ? { path: input.path === null ? undefined : input.path } : {}),
    }),
  );
  const repairRemoteSessionPaths = vi.fn(
    async (input: {
      sessionID: SessionInfo["id"];
      workspaceID: WorkspaceId;
      expectedDirectory: string;
      expectedPath: string | null;
      directory: string;
      path: string | null;
      timeUpdated: number;
    }): Promise<boolean> => {
      persisted = {
        ...persisted,
        directory: input.directory,
        ...(input.path === null ? { path: undefined } : { path: input.path }),
      };
      return true;
    },
  );
  const getSession = vi.fn(async () => persisted);
  return {
    store: { getSession, repairRemoteSessionPaths, updateSession } as Pick<
      SessionStorePort,
      "getSession" | "updateSession"
    > & { repairRemoteSessionPaths: typeof repairRemoteSessionPaths },
    getSession,
    repairRemoteSessionPaths,
    updateSession,
  };
}

describe("repairPersistedRemoteSessionPaths (IDE Windows drive form)", () => {
  it("repairs the legacy leading-slash form for Windows server sessions", async () => {
    const identity = "remote:server:zdy-pc:/E:/gitee/ezllm";
    const session = createSession({
      workspaceID: identity as WorkspaceId,
      directory: "/E:/gitee/ezllm",
      path: "/E:/gitee/ezllm",
    });
    const { store, repairRemoteSessionPaths, updateSession } = createUpdater(session);

    const repaired = await repairPersistedRemoteSessionPaths(store, session);

    expect(repairRemoteSessionPaths).toHaveBeenCalledWith({
      sessionID: session.id,
      workspaceID: session.workspaceID,
      expectedDirectory: "/E:/gitee/ezllm",
      expectedPath: "/E:/gitee/ezllm",
      directory: "E:/gitee/ezllm",
      path: "E:/gitee/ezllm",
      timeUpdated: session.time.updated,
    });
    expect(updateSession).not.toHaveBeenCalled();
    expect(repaired).toMatchObject({ directory: "E:/gitee/ezllm", path: "E:/gitee/ezllm" });
  });
});
