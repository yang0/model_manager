import path from "node:path";
import os from "node:os";

const appDataDir = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");

export const DATA_DIR = path.join(appDataDir, "model-manager");
export const STORAGE_PATH = path.join(DATA_DIR, "storage.json");
export const DEFAULT_BACKEND_PORT = Number(process.env.MODEL_MANAGER_PORT ?? 3199);
export const DEFAULT_POLLING_INTERVAL_SEC = 30;
export const MIN_POLLING_INTERVAL_SEC = 10;
export const MAX_POLLING_INTERVAL_SEC = 300;
export const LOCAL_GATEWAY_BASE_URL = (process.env.MODEL_MANAGER_GATEWAY_BASE_URL ?? `http://127.0.0.1:${DEFAULT_BACKEND_PORT}`)
  .trim()
  .replace(/\/+$/, "");
export const LOCAL_GATEWAY_TOKEN_PREFIX = "mm_ep_";
