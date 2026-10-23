import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { pdfJsCMapsPlugin } from "../ui/vite/pdfJsCMapsPlugin.js";
import {
  resolveBigModelApiOrigin,
  resolveRuntimeZCodeEndpointOrigin,
  resolveZaiOAuthClientId,
  resolveZaiOAuthOrigin,
} from "@zcode/shared/zcodeEndpoint";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");
const { version, zcodeCompatibility } = JSON.parse(
  readFileSync(resolve(REPO_ROOT, "package.json"), "utf-8"),
) as { version: string; zcodeCompatibility?: { minCompatibleVersion?: string } };
const minCompatibleVersion = zcodeCompatibility?.minCompatibleVersion ?? version;

export default defineConfig(({ mode }) => {
  // 与 packages/web 保持同一套链接常量来源：.env* 只提供常量，产品环境由 ZCODE_ENV 显式选择。
  const env = { ...loadEnv(mode, REPO_ROOT, ""), ...process.env };
  const zcodeEnv = env.ZCODE_ENV?.trim().toLowerCase() === "production" ? "production" : "test";
  const endpointEnv = { ...env, ZCODE_ENV: zcodeEnv };
  const zcodeEndpointOrigin = resolveRuntimeZCodeEndpointOrigin(endpointEnv);
  const zaiOAuthOrigin = resolveZaiOAuthOrigin(endpointEnv);
  const bigmodelOAuthOrigin = resolveBigModelApiOrigin(endpointEnv);
  const zaiOAuthClientId = resolveZaiOAuthClientId(endpointEnv);

  return {
    plugins: [pdfJsCMapsPlugin(), react(), tailwindcss()],
    resolve: {
      alias: {
        // packages/ui 源码里的 "@/..." 由消费方补别名（与 packages/web 一致）。
        "@": resolve(HERE, "../ui/src"),
        "d3-path": resolve(REPO_ROOT, "node_modules/d3-path/src/index.js"),
      },
    },
    server: {
      port: 5174,
      proxy: {
        "/ws": { target: "ws://localhost:3030", ws: true },
        "/api": { target: "http://localhost:3030" },
      },
    },
    optimizeDeps: {
      include: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime"],
    },
    define: {
      __ZCODE_VERSION__: JSON.stringify(version),
      __ZCODE_MIN_COMPATIBLE_VERSION__: JSON.stringify(minCompatibleVersion),
      __ZCODE_COMMIT__: JSON.stringify(env.ZCODE_COMMIT || "ide"),
      __ZCODE_ENV__: JSON.stringify(zcodeEnv),
      "import.meta.env.VITE_ZCODE_BASE_URL": JSON.stringify(zcodeEndpointOrigin),
      "import.meta.env.VITE_ZCODE_ENDPOINT_ORIGIN": JSON.stringify(zcodeEndpointOrigin),
      "import.meta.env.VITE_ZAI_OAUTH_CLIENT_ID": JSON.stringify(zaiOAuthClientId),
      "import.meta.env.VITE_ZAI_OAUTH_ORIGIN": JSON.stringify(zaiOAuthOrigin),
      "import.meta.env.VITE_BIGMODEL_OAUTH_ORIGIN": JSON.stringify(bigmodelOAuthOrigin),
    },
    build: {
      sourcemap: false,
    },
  };
});
