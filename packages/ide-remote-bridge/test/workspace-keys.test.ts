import assert from "node:assert/strict";
import test from "node:test";
import {
  dedupeWorkspacePaths,
  normalizeWorkspaceKey,
  resolveWorkspaceTarget,
  workspaceKeyMatches,
} from "../src/workspace-keys.ts";

test("手机回传正斜杠路径能匹配 server 的反斜杠写法", () => {
  const target = { workspacePath: "E:\\gitee\\zcode-ide" };
  assert.equal(workspaceKeyMatches(target, "E:/gitee/zcode-ide"), true);
  assert.equal(workspaceKeyMatches(target, "e:/GITEE/zcode-ide/"), true);
  assert.equal(workspaceKeyMatches(target, "E:/gitee/other"), false);
});

test("identity 仍可作为 workspaceKey 匹配", () => {
  const target = {
    workspacePath: "E:\\gitee\\zcode-ide",
    workspaceIdentity: "remote:server:zdy-pc:/e:/gitee/zcode-ide",
  };
  assert.equal(
    workspaceKeyMatches(target, "remote:server:zdy-pc:/E:/gitee/zcode-ide"),
    true,
  );
});

test("解析请求时返回列表项本身，调用方拿到 server 原始写法", () => {
  const targets = [
    { workspacePath: "E:\\gitee\\zcode-ide" },
    { workspacePath: "E:\\gitee\\baby-video" },
  ];
  assert.equal(
    resolveWorkspaceTarget(targets, "E:/gitee/zcode-ide")?.workspacePath,
    "E:\\gitee\\zcode-ide",
  );
  assert.equal(resolveWorkspaceTarget(targets, "e:\\GITEE\\baby-video\\")?.workspacePath, "E:\\gitee\\baby-video");
  assert.equal(resolveWorkspaceTarget(targets, "E:/gitee/nope"), undefined);
  assert.equal(resolveWorkspaceTarget(targets)?.workspacePath, "E:\\gitee\\zcode-ide");
});

test("去重按归一化结果判断，但保留第一次出现的原始写法", () => {
  assert.deepEqual(
    dedupeWorkspacePaths(["E:\\a\\b", "E:/a/b/", "E:\\a\\c", "  ", "e:\\A\\B"]),
    ["E:\\a\\b", "E:\\a\\c"],
  );
});

test("归一化只影响比较，不改变下发值", () => {
  assert.equal(normalizeWorkspaceKey("E:\\gitee\\zcode-ide\\"), "e:/gitee/zcode-ide");
});
