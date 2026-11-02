// Public types for the @endo/prompt-templates package.

/** A prompt template parsed from one markdown file. */
export interface PromptTemplate {
  /** The file name without `.md`; the user invokes it as `/<name>`. */
  name: string;
  /** Frontmatter `description`, else the body's first non-empty line. */
  description: string;
  /** The text expanded into the editor, without frontmatter. */
  body: string;
  /** Distinct `{{name}}` placeholders in order of first appearance. */
  variables: readonly string[];
  /** The label of the source the template was loaded from. */
  source: string;
}

/** One directory of template files, reachable however the host allows. */
export interface PromptTemplateSource {
  /** Identifies the source in templates and diagnostics. */
  label: string;
  /** Lists the entry names directly under the source. */
  list(): Promise<readonly string[]>;
  /** Reads one entry's full text. */
  readText(entryName: string): Promise<string>;
}

/** A file or source that could not be loaded, and why. */
export interface PromptTemplateDiagnostic {
  source: string;
  entryName?: string;
  message: string;
}

export interface LoadPromptTemplatesResult {
  /** Sorted by name, with one template per name. */
  templates: readonly PromptTemplate[];
  diagnostics: readonly PromptTemplateDiagnostic[];
}

/** How positional arguments distribute over a template's variables. */
export interface ArgumentBinding {
  /** Values for the variables that received an argument. */
  values: Readonly<Record<string, string>>;
  /** Variables left without an argument, in order. */
  missing: readonly string[];
  /** How many arguments exceed the template's variables. */
  excess: number;
}
