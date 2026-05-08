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
import type { ComputeService } from "../../services/compute.js";
import type { AppContext } from "../../app.js";
import { resolveAgentWithRuntime, buildClaudeArgs as buildClaudeArgsHelper } from "../../agent/agent.js";
import { getExecutor } from "../../executor.js";
import { buildTaskWithHandoff, extractSubtasks } from "../../services/task-builder.js";
import { startStatusPoller } from "../../executors/status-poller.js";
import { saveCheckpoint } from "../../session/checkpoint.js";

/**
 * Build a minimal AppContext-shaped shim from OrchestrationDeps. Used to bridge
 * helpers that still take `app: AppContext` until their signatures are
 * narrowed. The shim only exposes fields helpers actually read; accessing any
 * other property surfaces as undefined (which is fine -- helpers fail loudly
 * if they need fields the shim doesn't carry).
 *
 * This is intentionally a shim rather than a full refactor of every helper.
 * Phase 3.5 ports run incrementally by extending OrchestrationDeps and adding
 * fields here; Phase 3.5+ refactors helpers to take narrow deps directly and
 * the shim shrinks toward zero.
 */
function buildAppShim(d: OrchestrationDeps): AppContext {
  return {
    sessions: d.sessions,
    events: d.events,
    messages: d.messages,
    blobStore: d.blobStore,
    flows: d.flows,
    computes: d.computes,
    agents: d.agents,
    runtimes: d.runtimes,
    pluginRegistry: d.pluginRegistry,
    flowStates: d.flowStates,
    statusPollers: d.statusPollers,
    config: d.config,
    arkDir: d.arkDir,
    tenantId: d.tenantId,
    mode: { kind: "hosted", secrets: d.secrets },
  } as unknown as AppContext;
}

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

/** Minimal ComputeService stub. Throws on every access. Phase 3.5 follow-up. */
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

    // ── Phase 3.5 ports: real repos/stores from widened OrchestrationDeps ────
    runtimes: orchDeps.runtimes,
    flowStates: orchDeps.flowStates,
    pluginRegistry: orchDeps.pluginRegistry,
    statusPollers: orchDeps.statusPollers,
    // computeService: still stubbed -- not in OrchestrationDeps yet. The
    // dispatch chain only hits computeService.cloneTemplate for compute
    // template resolution; the e2e stub-runner path uses compute_name="local"
    // which short-circuits that branch.
    computeService: stubComputeService(),

    // models is optional -- omit; raw agent.model flows through in that case.

    // ── Hosted-mode scheduler ────────────────────────────────────────────────
    // Return null: the Temporal worker does not carry an AppContext-bound
    // SessionScheduler. The DispatchService uses the scheduler only in the
    // hosted-mode branch; Temporal workflows replace that path.
    // TODO(Phase 3.5): supply a real scheduler if the hosted-mode branch is
    // needed inside a Temporal activity.
    getScheduler: () => null,

    // ── Phase 3.5 ports: read directly from FlowStore ────────────────────────
    getStage: (flowName, stageName) => {
      const f = orchDeps.flows.get(flowName);
      // Hosted DB store can return a Promise on cache miss; treat as "not loaded".
      if (f && typeof (f as { then?: unknown }).then === "function") return null;
      const stages = (f as { stages?: any[] })?.stages ?? [];
      return stages.find((s: { name: string }) => s.name === stageName) ?? null;
    },
    getStageAction: (flowName, stageName) => {
      const f = orchDeps.flows.get(flowName);
      if (f && typeof (f as { then?: unknown }).then === "function") return { type: "unknown" };
      const stages = (f as { stages?: any[] })?.stages ?? [];
      const stage = stages.find((s: { name: string }) => s.name === stageName);
      if (!stage) return { type: "unknown" };
      if (stage.for_each !== undefined) {
        return { type: "for_each", on_failure: stage.on_failure, optional: stage.optional };
      }
      if (stage.type === "fork") {
        return {
          type: "fork",
          agent: stage.agent ?? "implementer",
          strategy: stage.strategy ?? "plan",
          max_parallel: stage.max_parallel ?? 4,
          on_failure: stage.on_failure,
          optional: stage.optional,
        };
      }
      if (stage.action) {
        return { type: "action", action: stage.action, on_failure: stage.on_failure, optional: stage.optional };
      }
      if (stage.agent) {
        return { type: "agent", agent: stage.agent, on_failure: stage.on_failure, optional: stage.optional };
      }
      return { type: "unknown", on_failure: stage.on_failure, optional: stage.optional };
    },
    // ── Phase 3.5 ports: helpers via AppContext shim from OrchestrationDeps ──
    buildTask: (session, stage, agentName) => buildTaskWithHandoff(buildAppShim(orchDeps), session, stage, agentName),
    extractSubtasks: (session) => extractSubtasks(buildAppShim(orchDeps), session),
    resolveAgent: (agentName, sessionVars, opts) =>
      resolveAgentWithRuntime(buildAppShim(orchDeps), agentName, sessionVars, opts),
    buildClaudeArgs: (agent, opts) =>
      buildClaudeArgsHelper(agent as any, {
        autonomy: opts.autonomy,
        projectRoot: opts.projectRoot,
        app: buildAppShim(orchDeps),
      }),
    resolveExecutor: (runtime) => orchDeps.pluginRegistry.executor(runtime) ?? getExecutor(runtime),

    // materializeClaudeAuth: only used for claude-code runtime. stub-runner /
    // Temporal e2e path doesn't hit it. Phase 3.5+ port reads secrets directly.
    materializeClaudeAuth: (_session, _compute) => notPortedYet("materializeClaudeAuth"),

    // ── Lifecycle / follow-on ─────────────────────────────────────────────────
    checkpoint: (sessionId) => {
      void saveCheckpoint({ sessions: orchDeps.sessions, events: orchDeps.events }, sessionId);
    },
    startStatusPoller: (sessionId, tmuxName, runtime) =>
      startStatusPoller(buildAppShim(orchDeps), sessionId, tmuxName, runtime),

    // mediateStageHandoff, executeAction, dispatchChild, fork: still stubbed.
    // Each goes through SessionService/StageAdvanceService/DispatchService
    // which carry their own AppContext-bound state. Porting is Phase 3.5+.
    mediateStageHandoff: (_sessionId, _opts) => notPortedYet("mediateStageHandoff"),
    executeAction: (_sessionId, _action) => notPortedYet("executeAction"),
    dispatchChild: (_childId) => notPortedYet("dispatchChild"),
    fork: (_parentId, _task, _opts) => notPortedYet("fork"),

    // getApp: feeds the executor LaunchOpts.app coupling. The shim is enough
    // for the executor to perform repo writes and event logging.
    getApp: () => buildAppShim(orchDeps),
  };
}
