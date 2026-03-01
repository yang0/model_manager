import path from "node:path";
import os from "node:os";
import { DEFAULT_POLLING_INTERVAL_SEC, MIN_POLLING_INTERVAL_SEC, MAX_POLLING_INTERVAL_SEC } from "./constants.js";

export function toIsoNow(): string {
  return new Date().toISOString();
}

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

export function expandHome(inputPath: string): string {
  if (!inputPath) {
    return inputPath;
  }
  if (inputPath.startsWith("~/")) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  if (inputPath === "~") {
    return os.homedir();
  }
  return inputPath;
}

export function maskSecret(secret: string): string {
  if (!secret) {
    return "";
  }
  if (secret.length <= 8) {
    return "****";
  }
  return `${secret.slice(0, 4)}****${secret.slice(-4)}`;
}

export function modelRecordId(endpointId: string, source: "dynamic" | "manual", modelId: string): string {
  return `${endpointId}::${source}::${modelId}`;
}

export function normalizePollingInterval(value?: number | null): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return DEFAULT_POLLING_INTERVAL_SEC;
  }
  if (value < MIN_POLLING_INTERVAL_SEC) {
    return MIN_POLLING_INTERVAL_SEC;
  }
  if (value > MAX_POLLING_INTERVAL_SEC) {
    return MAX_POLLING_INTERVAL_SEC;
  }
  return Math.floor(value);
}
