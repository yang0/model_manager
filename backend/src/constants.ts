import path from "node:path";
import os from "node:os";

const appDataDir = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");

export const DATA_DIR = path.join(appDataDir, "model-manager");
export const STORAGE_PATH = path.join(DATA_DIR, "storage.json");
export const DEFAULT_BACKEND_PORT = Number(process.env.MODEL_MANAGER_PORT ?? 3199);
export const DEFAULT_POLLING_INTERVAL_SEC = 30;
export const MIN_POLLING_INTERVAL_SEC = 10;
export const MAX_POLLING_INTERVAL_SEC = 300;
export const DEFAULT_SMART_ROUTING_MANAGEMENT_BASE_URL = "http://127.0.0.1:8317";
export const DEFAULT_SMART_ROUTING_MANAGEMENT_POLL_SEC = 20;
export const DEFAULT_SMART_ROUTING_INFERENCE_WINDOW_MIN = 10;
export const DEFAULT_SMART_ROUTING_INFERENCE_QUOTA_ERROR_THRESHOLD = 2;
