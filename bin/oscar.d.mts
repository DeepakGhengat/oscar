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
