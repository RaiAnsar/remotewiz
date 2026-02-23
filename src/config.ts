import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { z } from "zod";
import type { AppConfig, Project, RuntimeConfig } from "./types.js";

const DEFAULT_TOKEN_BUDGET = 100_000;
const DEFAULT_TIMEOUT_MS = 600_000;

const projectSchema = z
  .object({
    path: z.string().min(1),
    description: z.string().optional(),
    skipPermissions: z.boolean().optional().default(false),
    skipPermissionsReason: z.string().optional(),
    tokenBudget: z.number().int().positive().optional(),
    timeout: z.number().int().positive().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.skipPermissions && (!value.skipPermissionsReason || value.skipPermissionsReason.trim() === "")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "skipPermissionsReason is required when skipPermissions is true",
        path: ["skipPermissionsReason"],
      });
    }
  });

const configSchema = z.object({
  projects: z.record(projectSchema),
});

function parseIntEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${key}: expected positive integer`);
  }
  return parsed;
}

function parseBoolEnv(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (!raw) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function parseCsvSet(raw: string | undefined): Set<string> {
  if (!raw) {
    return new Set();
  }
  return new Set(
    raw
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

function resolveProject(alias: string, input: z.infer<typeof projectSchema>): Project {
  const resolved = path.resolve(input.path);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Project '${alias}' path does not exist: ${resolved}`);
  }
  const real = fs.realpathSync(resolved);
  return {
    alias,
    path: real,
    description: input.description,
    skipPermissions: input.skipPermissions,
    skipPermissionsReason: input.skipPermissionsReason,
    tokenBudget: input.tokenBudget ?? DEFAULT_TOKEN_BUDGET,
    timeout: input.timeout ?? DEFAULT_TIMEOUT_MS,
  };
}

export function loadRuntimeConfig(cwd = process.cwd()): { appConfig: AppConfig; runtimeConfig: RuntimeConfig } {
  dotenv.config({ path: path.join(cwd, ".env") });

  const configPath = path.join(cwd, "config.json");
  if (!fs.existsSync(configPath)) {
    throw new Error(`Missing config file: ${configPath}`);
  }

  const parsedConfig = configSchema.parse(JSON.parse(fs.readFileSync(configPath, "utf8")));

  const projects = Object.fromEntries(
    Object.entries(parsedConfig.projects).map(([alias, project]) => [alias, resolveProject(alias, project)]),
  );

  const appConfig: AppConfig = { projects };

  const runtimeConfig: RuntimeConfig = {
    discordToken: process.env.DISCORD_TOKEN,
    discordGuildId: process.env.DISCORD_GUILD_ID,
    discordChannelIds: parseCsvSet(process.env.DISCORD_CHANNEL_IDS),
    discordAllowedUsers: parseCsvSet(process.env.DISCORD_ALLOWED_USERS),
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    webPort: parseIntEnv("WEB_PORT", 3456),
    webBindHost: process.env.WEB_BIND_HOST || "127.0.0.1",
    webAuthToken: process.env.WEB_AUTH_TOKEN,
    maxConcurrentTasks: parseIntEnv("MAX_CONCURRENT_TASKS", 3),
    maxQueuedPerProject: parseIntEnv("MAX_QUEUED_PER_PROJECT", 5),
    defaultTokenBudget: parseIntEnv("DEFAULT_TOKEN_BUDGET", DEFAULT_TOKEN_BUDGET),
    defaultTimeoutMs: parseIntEnv("DEFAULT_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
    silenceTimeoutMs: parseIntEnv("SILENCE_TIMEOUT_MS", 90_000),
    approvalTimeoutMs: parseIntEnv("APPROVAL_TIMEOUT_MS", 1_800_000),
    replayTimeoutMs: parseIntEnv("REPLAY_TIMEOUT_MS", 120_000),
    summarizerEnabled: parseBoolEnv("SUMMARIZER_ENABLED", true),
  };

  return { appConfig, runtimeConfig };
}

export function projectRootFromModule(moduleUrl: string): string {
  const __filename = fileURLToPath(moduleUrl);
  return path.resolve(path.dirname(__filename), "..");
}
