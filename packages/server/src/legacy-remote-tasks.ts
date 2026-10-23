import { DatabaseSync } from "node:sqlite";
import {
  buildServerRemoteWorkspaceIdentity,
  remoteHostIdFromWorkspaceIdentity,
} from "@zcode/shared";
import { getTasksIndexDatabasePath } from "@zcode/services/storage-startup";

/**
 * 修复 IDE 插件早期版本写入的任务行。
 *
 * 那些行的 host_id 已经是 `remote:server:<id>`，但 workspace_key / workspace_identity
 * 还是裸路径。新版 UI 按 workspaceIdentity 解析工作区 scope：点开这类任务时
 * activateTabByPath 匹配不到同一个 key，setActiveTaskId 写到另一个 scope，
 * 界面既不加载也不报错（连 RPC 都不发），表现就是"点历史会话卡住不动"。
 *
 * 只在插件注入 ZCODE_SERVER_WORKSPACE 时调用，桌面端不受影响。幂等。
 */
export function normalizeLegacyRemoteTasks(serverId: string, workspacePath: string): number {
  const identity = buildServerRemoteWorkspaceIdentity({ serverId, workspacePath });
  const hostId =
    remoteHostIdFromWorkspaceIdentity(identity) ?? `remote:server:${serverId.toLowerCase()}`;

  const db = new DatabaseSync(getTasksIndexDatabasePath());
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const result = db
      .prepare(
        `UPDATE tasks
            SET workspace_key = ?, workspace_identity = ?
          WHERE host_id = ?
            AND workspace_path = ?
            AND (workspace_identity IS NULL OR trim(workspace_identity) = '')`,
      )
      .run(identity, identity, hostId, workspacePath);
    return Number(result.changes ?? 0);
  } finally {
    db.close();
  }
}
