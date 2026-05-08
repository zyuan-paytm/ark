/**
 * Factory: OrchestrationDeps -> DispatchDeps
 *
 * Constructs a DispatchDeps from the narrow OrchestrationDeps that Temporal
 * activities carry, without ever touching AppContext.
 *
 * Fields that come directly from OrchestrationDeps are wired through as-is.
 * Fields that still depend on AppContext (resolveAgent, buildTask,
 * materializeClaudeAuth, etc.) are stubbed with a clear "not yet ported"
 * error. These stubs are intentional placeholders -- Phase 3.5 will replace
 * them with self-contained implementations that do not require AppContext.
 *
 * The only field that structurally cannot be provided without AppContext is
 * `getApp`, which exists solely to satisfy the executor LaunchOpts.app
 * coupling. It throws as well; the executor migration is tracked separately.
 */

import type { DispatchDeps } from "../../services/dispatch/types.js";
import type { OrchestrationDeps } from "../../services/deps.js";
import type { BlobStore } from "../../storage/blob-store.js";
import type { RuntimeStore } from "../../stores/runtime-store.js";
import type { FlowStateRepository } from "../../repositories/flow-state.js";
import type { ComputeService } from "../../services/compute.js";
import type { PluginRegistry, PluginKind, PluginEntry } from "../../plugins/registry.js";
import { StatusPollerRegistry } from "../../executors/status-poller.js";

/**
 * DispatchDeps extended with OrchestrationDeps fields that Temporal activities
 * need but that are not part of the core DispatchService contract.
 * `blobStore` is the only addition today -- kept here so activities can read
 * session inputs without going through AppContext.
 */
export type TemporalDispatchDeps = DispatchDeps & {
  /** Pass-through from OrchestrationDeps for activities that read blob inputs. */
  blobStore: BlobStore;
};

// ── Minimal stub helpers ─────────────────────────────────────────────────────

function notPortedYet(field: string): never {
  throw new Error(
    `buildDispatchDeps: "${field}" requires AppContext and is not yet ported -- Phase 3.5`,
  );
}

/** Minimal RuntimeStore stub. Throws on every access. */
function stubRuntimeStore(): RuntimeStore {
  return {
    list: () => notPortedYet("runtimes.list"),
    get: () => notPortedYet("runtimes.get"),
    save: () => notPortedYet("runtimes.save"),
    delete: () => notPortedYet("runtimes.delete"),
  };
}

/** Minimal FlowStateRepository stub. Throws on every access. */
function stubFlowStateRepository(): FlowStateRepository {
  // FlowStateRepository is a class; we cast through unknown so the type
  // checker is satisfied while keeping zero AppContext references.
  const stub = {
    setTenant: () => notPortedYet("flowStates.setTenant"),
    getTenant: () => notPortedYet("flowStates.getTenant"),
    load: () => notPortedYet("flowStates.load"),
    save: () => notPortedYet("flowStates.save"),
    setCurrentStage: () => notPortedYet("flowStates.setCurrentStage"),
    markStageCompleted: () => notPortedYet("flowStates.markStageCompleted"),
    markStageSkipped: () => notPortedYet("flowStates.markStageSkipped"),
    initForSession: () => notPortedYet("flowStates.initForSession"),
    getCompletedStages: () => notPortedYet("flowStates.getCompletedStages"),
  };
  return stub as unknown as FlowStateRepository;
}

/** Minimal ComputeService stub. Throws on every access. */
function stubComputeService(): ComputeService {
  const stub = {
    create: () => notPortedYet("computeService.create"),
    update: () => notPortedYet("computeService.update"),
    delete: () => notPortedYet("computeService.delete"),
    get: () => notPortedYet("computeService.get"),
    list: () => notPortedYet("computeService.list"),
    cloneTemplate: () => notPortedYet("computeService.cloneTemplate"),
  };
  return stub as unknown as ComputeService;
}

/** Minimal PluginRegistry stub. Throws on every access. */
function stubPluginRegistry(): PluginRegistry {
  return {
    register: (_entry: PluginEntry<PluginKind>) => notPortedYet("pluginRegistry.register"),
    unregister: () => notPortedYet("pluginRegistry.unregister"),
    get: () => notPortedYet("pluginRegistry.get"),
    getEntry: () => notPortedYet("pluginRegistry.getEntry"),
    listByKind: () => notPortedYet("pluginRegistry.listByKind"),
    clear: () => notPortedYet("pluginRegistry.clear"),
    executor: () => notPortedYet("pluginRegistry.executor"),
  };
}

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * Build a DispatchDeps from OrchestrationDeps.
 *
 * Callers (Temporal activities) pass this result to `new DispatchService()`
 * instead of constructing DispatchDeps inside `di/services.ts` where
 * AppContext is available. The stubs ensure activities that don't exercise the
 * AppContext-dependent paths (the common Temporal case: hosted-mode launch via
 * scheduler) fail loudly rather than silently misbehaving.
 */
export function buildDispatchDeps(orchDeps: OrchestrationDeps): TemporalDispatchDeps {
  return {
    // ── Direct pass-through from OrchestrationDeps ───────────────────────────
    sessions: orchDeps.sessions,
    events: orchDeps.events,
    computes: orchDeps.computes,
    flows: orchDeps.flows,
    config: orchDeps.config,
    secrets: orchDeps.secrets,
    blobStore: orchDeps.blobStore,

    // ── Stubs for fields absent from OrchestrationDeps ───────────────────────
    // TODO(Phase 3.5): wire real runtimes store when migrating resolveAgent
    runtimes: stubRuntimeStore(),
    // TODO(Phase 3.5): wire real flowStates repository
    flowStates: stubFlowStateRepository(),
    // TODO(Phase 3.5): wire real computeService
    computeService: stubComputeService(),
    // TODO(Phase 3.5): wire real pluginRegistry
    pluginRegistry: stubPluginRegistry(),
    // StatusPollerRegistry is a concrete class; supply an empty instance.
    // The poller is not used on the Temporal hosted-mode path (scheduler
    // manages compute lifecycle instead). Phase 3.5 will decide whether to
    // pass a real registry here.
    statusPollers: new StatusPollerRegistry(),

    // models is optional -- omit; raw agent.model flows through in that case.

    // ── Hosted-mode scheduler ────────────────────────────────────────────────
    // Return null: the Temporal worker does not carry an AppContext-bound
    // SessionScheduler. The DispatchService uses the scheduler only in the
    // hosted-mode branch; Temporal workflows replace that path.
    // TODO(Phase 3.5): supply a real scheduler if the hosted-mode branch is
    // needed inside a Temporal activity.
    getScheduler: () => null,

    // ── AppContext-dependent callbacks -- stubbed, Phase 3.5 ─────────────────
    getStage: (_flowName, _stageName) => notPortedYet("getStage"),
    getStageAction: (_flowName, _stageName) => notPortedYet("getStageAction"),
    buildTask: (_session, _stage, _agentName) => notPortedYet("buildTask"),
    extractSubtasks: (_session) => notPortedYet("extractSubtasks"),
    materializeClaudeAuth: (_session, _compute) => notPortedYet("materializeClaudeAuth"),
    resolveAgent: (_agentName, _sessionVars, _opts) => notPortedYet("resolveAgent"),
    buildClaudeArgs: (_agent, _opts) => notPortedYet("buildClaudeArgs"),
    resolveExecutor: (_runtime) => notPortedYet("resolveExecutor"),

    // ── Lifecycle / follow-on -- stubbed, Phase 3.5 ───────────────────────────
    checkpoint: (_sessionId) => notPortedYet("checkpoint"),
    mediateStageHandoff: (_sessionId, _opts) => notPortedYet("mediateStageHandoff"),
    executeAction: (_sessionId, _action) => notPortedYet("executeAction"),
    dispatchChild: (_childId) => notPortedYet("dispatchChild"),
    fork: (_parentId, _task, _opts) => notPortedYet("fork"),
    startStatusPoller: (_sessionId, _tmuxName, _runtime) => notPortedYet("startStatusPoller"),

    // ── Executor-interface coupling -- not portable without AppContext ─────────
    // getApp is used only to satisfy LaunchOpts.app inside executor.launch().
    // Migrating executors off AppContext is tracked separately (Phase 3.5+).
    getApp: () => notPortedYet("getApp"),
  };
}
