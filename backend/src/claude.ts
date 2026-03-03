import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { expandHome } from "./utils.js";

interface ApplyClaudeConfigInput {
  settingsPath: string;
  baseUrl: string;
  apiKey: string;
  modelId: string;
  modelKey: string;
}

interface ApplyClaudeConfigResult {
  settingsPath: string;
  backupPath?: string;
  updatedKeys: string[];
}

export interface ClaudeCurrentConfig {
  settingsPath: string;
  exists: boolean;
  env: {
    ANTHROPIC_BASE_URL?: string;
    ANTHROPIC_AUTH_TOKEN?: string;
    modelValues: Record<string, string>;
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export async function detectDefaultClaudeSettingsPath(): Promise<string> {
  const candidate = path.join(os.homedir(), ".claude", "settings.json");
  try {
    await fs.access(candidate);
    return candidate;
  } catch {
    return candidate;
  }
}

export async function applyClaudeSettings(input: ApplyClaudeConfigInput): Promise<ApplyClaudeConfigResult> {
  const absolutePath = path.resolve(expandHome(input.settingsPath));
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });

  let existingRaw = "";
  let parsed: Record<string, unknown> = {};
  let backupPath: string | undefined;

  try {
    existingRaw = await fs.readFile(absolutePath, "utf8");
    const maybeJson: unknown = existingRaw.trim() ? JSON.parse(existingRaw) : {};
    if (!isObject(maybeJson)) {
      throw new Error("Claude settings must be a JSON object.");
    }
    parsed = maybeJson;

    backupPath = `${absolutePath}.bak.${Date.now()}`;
    await fs.copyFile(absolutePath, backupPath);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") {
      throw error;
    }
  }

  const envValue = isObject(parsed.env) ? parsed.env : {};
  // Historical cleanup: avoid persisting accidental "env.undefined" entries.
  if (Object.prototype.hasOwnProperty.call(envValue, "undefined")) {
    delete envValue.undefined;
  }
  envValue.ANTHROPIC_BASE_URL = input.baseUrl.trim().replace(/\/+$/, "");
  envValue.ANTHROPIC_AUTH_TOKEN = input.apiKey;
  const isRootModel = input.modelKey === "model";
  if (isRootModel) {
    parsed.model = input.modelId;
  } else {
    envValue[input.modelKey] = input.modelId;
  }

  const nextJson: Record<string, unknown> = {
    ...parsed,
    env: envValue,
  };

  await fs.writeFile(absolutePath, `${JSON.stringify(nextJson, null, 2)}\n`, "utf8");

  return {
    settingsPath: absolutePath,
    backupPath,
    updatedKeys: [
      "env.ANTHROPIC_BASE_URL",
      "env.ANTHROPIC_AUTH_TOKEN",
      isRootModel ? "model" : `env.${input.modelKey}`,
    ],
  };
}

export async function readClaudeSettings(settingsPath: string): Promise<ClaudeCurrentConfig> {
  const absolutePath = path.resolve(expandHome(settingsPath));
  try {
    const raw = await fs.readFile(absolutePath, "utf8");
    const parsedUnknown: unknown = raw.trim() ? JSON.parse(raw) : {};
    const parsed = isObject(parsedUnknown) ? parsedUnknown : {};
    const envUnknown = parsed.env;
    const envObj = isObject(envUnknown) ? envUnknown : {};
    const modelValues: Record<string, string> = {};
    if (typeof parsed.model === "string") {
      modelValues.model = parsed.model;
    }
    for (const [key, value] of Object.entries(envObj)) {
      if (typeof value === "string" && key.toUpperCase().includes("MODEL")) {
        modelValues[key] = value;
      }
    }

    return {
      settingsPath: absolutePath,
      exists: true,
      env: {
        ANTHROPIC_BASE_URL: typeof envObj.ANTHROPIC_BASE_URL === "string" ? envObj.ANTHROPIC_BASE_URL : undefined,
        ANTHROPIC_AUTH_TOKEN: typeof envObj.ANTHROPIC_AUTH_TOKEN === "string" ? envObj.ANTHROPIC_AUTH_TOKEN : undefined,
        modelValues,
      },
    };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return {
        settingsPath: absolutePath,
        exists: false,
        env: {
          modelValues: {},
        },
      };
    }
    throw error;
  }
}
