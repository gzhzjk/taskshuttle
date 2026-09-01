import type { HostManifest } from './manifest.js';
import { buildHost, type BuildHostContext } from './build-host.js';
import type { ArgvRunResult } from './argv-runner.js';
import type { ScopedFilesystem } from './scoped-fs.js';

/** A filesystem root granted by the orchestrator to one host operation. */
export interface HostOperationRoots {
  readonly repository: string;
  readonly host: string;
  readonly output: string;
  readonly managed?: string;
}

/** Canonical filesystem capabilities granted to a host deployment. */
export interface HostDeployFiles {
  readonly repository: ScopedFilesystem;
  readonly home: ScopedFilesystem;
  /** Optional managed-host root granted by the coordinator after canonical validation. */
  readonly managed?: ScopedFilesystem;
}

/** Context visible to a driver's read-only inspection operation. */
export interface HostInspectContext {
  readonly manifest: HostManifest;
  readonly roots: HostOperationRoots;
}

/** Host-specific deployment context supplied by the Plugin coordinator. */
export interface HostDeployContext extends HostInspectContext {
  readonly dryRun: boolean;
  readonly scope: 'user' | 'project' | 'local';
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  onPath(binary: string): boolean;
  readonly files: HostDeployFiles;
  run(command: HostCommand): Promise<ArgvRunResult | null>;
  requireRun(command: HostCommand, what: string): Promise<string | null>;
}

/** Context for a host-owned artifact validator used by the release gate. */
export interface HostArtifactValidationContext extends HostInspectContext {
  readonly artifactManifest: unknown;
  readonly artifactManifestPath: string;
  readonly nannyHookEntry: string;
}

export interface HostArtifactValidationIssue {
  readonly path: string;
  readonly message: string;
}

/** Context for materializing generated host output. */
export interface HostStageContext extends HostInspectContext {
  readonly pluginBundle: string;
  readonly sharedSkills: string;
  readonly legalSources: readonly string[];
}

/** A command plan returned to the central deploy coordinator. */
export interface HostCommand {
  readonly binary: string;
  readonly argv: readonly string[];
  readonly cwd?: string;
}

/** Result of a host lifecycle operation; drivers never execute commands directly. */
export interface HostOperationResult {
  readonly status: 'ok' | 'manual' | 'skipped';
  readonly detail: string;
  readonly commands?: readonly HostCommand[];
}

/** Typed lifecycle owned by one host directory. */
export interface HostDriver {
  readonly id: string;
  /** Optional generated marketplace payload owned by this host. */
  readonly marketplacePayload?: string;
  inspect(context: HostInspectContext): Promise<HostOperationResult>;
  validateArtifacts?(context: HostArtifactValidationContext): readonly HostArtifactValidationIssue[];
  deploy?(context: HostDeployContext): Promise<HostOperationResult>;
  stage(context: HostStageContext): Promise<HostOperationResult>;
  install(context: HostInspectContext): Promise<HostOperationResult>;
  verify(context: HostInspectContext): Promise<HostOperationResult>;
  uninstall(context: HostInspectContext): Promise<HostOperationResult>;
}

export interface DeclarativeHostDriverOptions {
  readonly marketplacePayload?: string;
  readonly install?: HostCommand[];
  readonly verify?: HostCommand[];
  readonly uninstall?: HostCommand[];
  readonly installDetail?: string;
  readonly verifyDetail?: string;
  readonly uninstallDetail?: string;
  readonly deploy?: (context: HostDeployContext) => Promise<HostOperationResult>;
  readonly validateArtifacts?: (context: HostArtifactValidationContext) => readonly HostArtifactValidationIssue[];
}

/** Create a host driver whose effects are explicit typed command plans. */
export function createHostDriver(id: string, options: DeclarativeHostDriverOptions = {}): HostDriver {
  return {
    id,
    ...(options.marketplacePayload === undefined ? {} : { marketplacePayload: options.marketplacePayload }),
    async inspect() { return { status: 'ok', detail: `host '${id}' inspected` }; },
    ...(options.validateArtifacts === undefined ? {} : { validateArtifacts: options.validateArtifacts }),
    ...(options.deploy === undefined ? {} : { deploy: options.deploy }),
    async stage(context) {
      const buildContext: BuildHostContext = {
        pluginBundle: context.pluginBundle,
        sharedSkills: context.sharedSkills,
        legalSources: context.legalSources,
      };
      await buildHost(context.manifest, buildContext, context.roots.output);
      return { status: 'ok', detail: `host '${id}' staged at ${context.roots.output}` };
    },
    async install() {
      return { status: options.install === undefined ? 'manual' : 'ok', detail: options.installDetail ?? `host '${id}' install plan`, ...(options.install === undefined ? {} : { commands: options.install }) };
    },
    async verify() {
      return { status: options.verify === undefined ? 'manual' : 'ok', detail: options.verifyDetail ?? `host '${id}' verification plan`, ...(options.verify === undefined ? {} : { commands: options.verify }) };
    },
    async uninstall() {
      return { status: options.uninstall === undefined ? 'manual' : 'ok', detail: options.uninstallDetail ?? `host '${id}' uninstall plan`, ...(options.uninstall === undefined ? {} : { commands: options.uninstall }) };
    },
  };
}
