// Saved configurations, so switching backends is not a re-run of the wizard.
//
// `oscar --setup` writes the whole .env. That is correct for a first run and
// destructive for everything after: choosing "Anthropic account sign-in" over
// a working Ollama setup silently discards the base URL, key and model, and
// the only way back is to type them all again.
//
// So every setup also saves a copy under `<config>/profiles/<name>.env`, and
// `oscar --use <name>` copies one back over the active .env. The active file
// stays exactly where it was — nothing else in the tool needs to know profiles
// exist.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** Where the active config lives — the same rule the rest of the tool uses. */
export function configDir(): string {
  return process.env.OSCAR_CONFIG ? resolve(process.env.OSCAR_CONFIG) : resolve(".");
}

export function profilesDir(dir = configDir()): string {
  return join(dir, "profiles");
}

/** Profile names become filenames, so keep them boring. */
export function sanitizeProfileName(name: string): string {
  const clean = String(name ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 40);
  return clean;
}

export function profilePath(name: string, dir = configDir()): string {
  return join(profilesDir(dir), `${sanitizeProfileName(name)}.env`);
}

/** Save `text` as a named profile. Returns the path written, or null when the
 * name sanitizes to nothing. */
export function saveProfile(name: string, text: string, dir = configDir()): string | null {
  const safe = sanitizeProfileName(name);
  if (!safe) return null;
  const path = profilePath(safe, dir);
  mkdirSync(profilesDir(dir), { recursive: true });
  writeFileSync(path, text);
  return path;
}

export interface ProfileInfo {
  name: string;
  path: string;
  /** One line describing what this profile actually does. */
  summary: string;
  /** True when it is byte-identical to the active .env. */
  active: boolean;
}

const TRUTHY = new Set(["1", "true", "yes", "on"]);

/** Parse just enough of an env file to describe it. */
export function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[line.slice(0, eq).trim()] = v;
  }
  return out;
}

/** A short, honest description of a config: which world, and which model. */
export function describeProfile(text: string): string {
  const env = parseEnvText(text);
  if (TRUTHY.has((env.USE_OPENAI_API ?? "").toLowerCase())) {
    const model = env.OPENAI_MODEL || "(no model)";
    const host = (env.OPENAI_BASE_URL || "(no base URL)").replace(/^https?:\/\//, "");
    return `${model} via ${host}`;
  }
  const auth = (env.OSCAR_AUTH ?? "").toLowerCase();
  if (["subscription", "oauth", "sso", "login"].includes(auth)) {
    return "Anthropic account sign-in (the CLI's own login)";
  }
  if (env.ANTHROPIC_API_KEY) return "Anthropic API key (passthrough)";
  return "Anthropic account sign-in (no key stored)";
}

/** Every saved profile, newest name order, with the active one marked. */
export function listProfiles(dir = configDir()): ProfileInfo[] {
  const pdir = profilesDir(dir);
  if (!existsSync(pdir)) return [];
  const activePath = join(dir, ".env");
  let active = "";
  try {
    if (existsSync(activePath)) active = readFileSync(activePath, "utf8");
  } catch {
    active = "";
  }
  const out: ProfileInfo[] = [];
  for (const file of readdirSync(pdir).sort()) {
    if (!file.endsWith(".env")) continue;
    const path = join(pdir, file);
    let text = "";
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    out.push({
      name: file.slice(0, -4),
      path,
      summary: describeProfile(text),
      active: active !== "" && text.trim() === active.trim(),
    });
  }
  return out;
}

export interface ActivateResult {
  ok: boolean;
  /** Set when ok is false: why not. */
  error?: string;
  /** Set when ok: what was switched to. */
  summary?: string;
}

/** Make `name` the active config.
 *
 * The current .env is saved back to its own profile first when it does not
 * match any saved one, so switching never loses an unsaved setup. */
export function activateProfile(name: string, dir = configDir()): ActivateResult {
  const safe = sanitizeProfileName(name);
  if (!safe) return { ok: false, error: `"${name}" is not a usable profile name` };
  const path = profilePath(safe, dir);
  if (!existsSync(path)) {
    const known = listProfiles(dir).map((p) => p.name);
    return {
      ok: false,
      error: known.length
        ? `no profile named "${safe}". Saved: ${known.join(", ")}`
        : `no profile named "${safe}", and none are saved yet. Run oscar --setup first.`,
    };
  }

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    return { ok: false, error: `could not read ${path}: ${(err as Error).message}` };
  }

  const activePath = join(dir, ".env");
  try {
    if (existsSync(activePath)) {
      const current = readFileSync(activePath, "utf8");
      const alreadySaved = listProfiles(dir).some((p) => p.active);
      if (!alreadySaved && current.trim()) saveProfile("previous", current, dir);
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(activePath, text);
  } catch (err) {
    return { ok: false, error: `could not write ${activePath}: ${(err as Error).message}` };
  }

  return { ok: true, summary: describeProfile(text) };
}
