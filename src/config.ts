/**
 * Configuration for the pi-debug-mode extension.
 *
 * Every option is read from an environment variable with a sane default, so
 * capture can be tuned per process without touching pi settings. Invalid
 * values fall back to the default and log a warning — a misconfigured debug
 * tool must never take pi down.
 */
import { homedir } from "node:os";
import { join } from "node:path";

export interface DebugConfig {
  /** Root directory for trace output (session subdirectories are created under it). */
  dir: string;
  /** Capacity of the in-memory ring buffer, in events. */
  ringSize: number;
  /** Append new events to the on-disk trace every N events. */
  flushEvery: number;
  /** Maximum number of .jsonl files kept per session directory (trace + snapshots). */
  maxFiles: number;
  /** Maximum bytes per trace file before it rotates. */
  maxFileBytes: number;
  /** Capture full (redacted, truncated) provider payloads instead of summaries only. */
  fullCapture: boolean;
  /** Maximum characters kept for any single captured string value. */
  maxString: number;
}

export function defaultConfig(): DebugConfig {
  return {
    dir: join(homedir(), ".pi", "agent", "debug"),
    ringSize: 1000,
    flushEvery: 500,
    maxFiles: 10,
    maxFileBytes: 1024 * 1024,
    fullCapture: false,
    maxString: 500,
  };
}

function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`[pi-debug-mode] invalid ${name}="${raw}" (expected a positive integer); using ${fallback}`);
    return fallback;
  }
  return n;
}

function booleanValue(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  if (["1", "true", "yes", "on"].includes(raw.trim().toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(raw.trim().toLowerCase())) return false;
  console.error(`[pi-debug-mode] invalid ${name}="${raw}" (expected 0/1 or true/false); using ${fallback}`);
  return fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DebugConfig {
  const cfg = defaultConfig();
  const dir = env.PI_DEBUG_DIR?.trim();
  if (dir) cfg.dir = dir;
  cfg.ringSize = positiveInt(env, "PI_DEBUG_RING_SIZE", cfg.ringSize);
  cfg.flushEvery = positiveInt(env, "PI_DEBUG_FLUSH_EVERY", cfg.flushEvery);
  cfg.maxFiles = positiveInt(env, "PI_DEBUG_MAX_FILES", cfg.maxFiles);
  cfg.maxFileBytes = positiveInt(env, "PI_DEBUG_MAX_FILE_BYTES", cfg.maxFileBytes);
  cfg.maxString = positiveInt(env, "PI_DEBUG_MAX_STRING", cfg.maxString);
  cfg.fullCapture = booleanValue(env, "PI_DEBUG_FULL_CAPTURE", cfg.fullCapture);
  return cfg;
}
