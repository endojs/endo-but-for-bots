// Public types for the @endo/skills package.

/** A skill parsed from one `SKILL.md`, per the agentskills.io format. */
export interface Skill {
  /** Frontmatter `name`, else the skill directory's name. */
  name: string;
  /** Frontmatter `description`; tells the model when to load the skill. */
  description: string;
  /** Path to the `SKILL.md` file, as the source reports it. */
  filePath: string;
  /** Directory holding `SKILL.md`; relative references resolve against it. */
  baseDir: string;
  /** The label of the source the skill was loaded from. */
  source: string;
  license?: string;
  compatibility?: string;
  /** Frontmatter `allowed-tools`, split on whitespace. Advisory only. */
  allowedTools: readonly string[];
  /** When true, the skill is left out of the system prompt. */
  disableModelInvocation: boolean;
  /** Frontmatter `metadata`, a one-level string map. */
  metadata: Readonly<Record<string, string>>;
}

/** One directory of skill directories, reachable however the host allows. */
export interface SkillSource {
  /** Identifies the source in skills and diagnostics. */
  label: string;
  /** Lists the entry names directly under the source. */
  list(): Promise<readonly string[]>;
  /**
   * Reads `<entryName>/SKILL.md`, or returns `undefined` when the entry is
   * not a skill directory.
   */
  readSkillText(entryName: string): Promise<string | undefined>;
  /** Names the `SKILL.md` path and directory for an entry. */
  locate(entryName: string): { filePath: string; baseDir: string };
}

/**
 * A skill or source that broke a rule. A `warning` leaves the skill loaded,
 * following Pi's leniency toward skills written for other harnesses; an
 * `error` means the skill or source was not loaded.
 */
export interface SkillDiagnostic {
  severity: 'warning' | 'error';
  source: string;
  entryName?: string;
  message: string;
}

export interface LoadSkillsResult {
  /** Loaded skills, sorted by name. */
  skills: readonly Skill[];
  diagnostics: readonly SkillDiagnostic[];
}
