// Types for the pure helpers the launcher exports so tests can typecheck.
// The CLI entry point itself is not part of the public surface.

export declare function parseEnvFile(content: string): Record<string, string>;

export declare function compareVersions(a: string, b: string): number;

export declare function newestVersioned(
  root: string,
  exe: string,
): { path: string; version: string } | null;

export declare function isCliEntry(argv1: string | undefined, self: string): boolean;

export declare function banner(lines: string[]): string;

export declare function seedClaudeProfile(dir: string, statusLineCmd?: string): void;

export declare function isSubscriptionAuth(env?: Record<string, string | undefined>): boolean;

export declare function cliExeNames(platform?: string): string[];

export declare function findOnPath(
  names: string[],
  pathVar?: string,
  platform?: string,
): string | null;

export declare function needsShell(binPath: string, platform?: string): boolean;

export declare function quoteForShell(s: string): string;

export declare function apiKeyId(key: string | null | undefined): string;

export declare function approveApiKey(dir: string, key: string): Record<string, unknown>;

export declare function isHybrid(env?: Record<string, string | undefined>): boolean;

export declare function isBareModelFlag(args: string[]): boolean;
