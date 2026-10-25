/**
 * 构建远控桥单文件产物。
 *
 * 直接用仓库根的 esbuild（不新增 workspace 依赖，避免动 pnpm-lock）：
 * 产物是 ESM，运行时由插件提供的 Node 24 执行。
 */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const here = import.meta.dirname;
const bridgeRoot = resolve(here, "..");
const zcodeRoot = resolve(bridgeRoot, "../..");
const esbuildBin = resolve(zcodeRoot, "node_modules/esbuild/bin/esbuild");

execFileSync(
  process.execPath,
  [
    esbuildBin,
    resolve(bridgeRoot, "src/index.ts"),
    "--bundle",
    "--platform=node",
    "--format=esm",
    `--outfile=${resolve(bridgeRoot, "dist/index.mjs")}`,
    // desktop transport 里的遥测依赖不属于插件侧，构建时替换为空实现。
    `--alias:#src/main/desktopNetworkTelemetry.js=${resolve(bridgeRoot, "src/telemetry-shim.ts")}`,
    // ws 等 CJS 依赖被 bundle 后仍可能走动态 require，注入 createRequire。
    "--banner:js=import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  ],
  { stdio: "inherit" },
);
