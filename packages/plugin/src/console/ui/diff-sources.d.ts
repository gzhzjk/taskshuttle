/**
 * Type declarations for the DOM-free diff derivation (diff-sources.js).
 * Structural and deliberately loose, like tool-row-state.d.ts: the console
 * renders whatever engines report, so an update is a record rather than an ACP
 * vocabulary type.
 */

export declare const PATCH_TEXT_LIMIT: number;

export interface DerivedDiffEntry {
  /** `engine` for an ACP diff block, `reconstructed` for one rebuilt from edit parameters. */
  readonly origin: 'engine' | 'reconstructed';
  /** Position within the carrying event; never renumbered, so a dropped segment leaves a gap. */
  readonly part: number;
  readonly path?: string;
  readonly oldText: string;
  readonly newText: string;
  /** A patch segment that declared a deletion and carried no lines: no counts are claimed. */
  readonly deleted?: true;
}

export declare function deriveDiffEntries(update: unknown): DerivedDiffEntry[];

export declare function derivedEntryKey(entry: DerivedDiffEntry): string;
