// Types for the pure helpers the status line exports so tests can typecheck.

export interface StatusSession {
  model?: { id?: string; display_name?: string };
  workspace?: { current_dir?: string; project_dir?: string };
  cwd?: string;
}

export interface StatusCatalog {
  entries: Array<{ provider: string; model: string; alias: string }>;
  providers: number;
}

export interface ActiveModel {
  /** The model to show — a backend model's real name, or the CLI's own label. */
  label: string;
  /** Where requests for it go: a provider id, or "anthropic". */
  via: string;
  /** True when one of our backends serves it. */
  backend: boolean;
}

export declare function describeActive(
  session: StatusSession | null | undefined,
  cat: StatusCatalog | null | undefined,
): ActiveModel | null;

export declare function shortPath(dir: string | undefined): string;
