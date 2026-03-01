import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";

export interface CliproxyConfigImport {
  configPath: string;
  endpointName: string;
  baseUrl: string;
  apiKey: string;
}

function normalizeHost(host: string | undefined): string {
  const value = (host ?? "").trim();
  if (!value || value === "0.0.0.0" || value === "::") {
    return "127.0.0.1";
  }
  return value;
}

export function getCliproxyConfigCandidates(): string[] {
  const result = new Set<string>();
  const envPath = process.env.CLIPROXY_CONFIG_PATH;
  if (envPath) {
    result.add(path.resolve(envPath));
  }
  result.add(path.join(os.homedir(), ".cli-proxy-api", "config.yaml"));
  result.add("H:\\tools\\CLIProxyAPI_6.8.34_windows_amd64\\config.yaml");
  return [...result];
}

function toObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parseCliproxyDocument(document: string, sourceLabel: string): CliproxyConfigImport {
  const parsedUnknown = parse(document) as unknown;
  const parsed = toObject(parsedUnknown);

  const host = normalizeHost(typeof parsed.host === "string" ? parsed.host : undefined);
  const portValue = parsed.port;
  const port = typeof portValue === "number" ? portValue : 8317;

  const apiKeysRaw = parsed["api-keys"];
  const apiKeys = Array.isArray(apiKeysRaw) ? apiKeysRaw : [];
  const apiKey = apiKeys.find((item): item is string => typeof item === "string" && item.trim().length > 0);

  if (!apiKey) {
    throw new Error(`No api-keys found in ${sourceLabel}`);
  }

  return {
    configPath: sourceLabel,
    endpointName: "CLIProxy Local",
    baseUrl: `http://${host}:${port}`,
    apiKey,
  };
}

export async function readCliproxyConfig(configPath: string): Promise<CliproxyConfigImport> {
  const absolutePath = path.resolve(configPath);
  const raw = await fs.readFile(absolutePath, "utf8");
  return parseCliproxyDocument(raw, absolutePath);
}

export function readCliproxyConfigFromContent(content: string, sourceLabel: string): CliproxyConfigImport {
  return parseCliproxyDocument(content, sourceLabel);
}

export async function discoverCliproxyConfig(): Promise<CliproxyConfigImport | null> {
  for (const candidate of getCliproxyConfigCandidates()) {
    try {
      const info = await readCliproxyConfig(candidate);
      return info;
    } catch {
      // Ignore invalid candidate and continue probing.
    }
  }
  return null;
}
