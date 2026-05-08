/**
 * T1-T5: Temporal orchestration e2e tests.
 *
 * Phase 2 test strategy: The Temporal workflow runs in the background
 * (watching for completion). The bespoke engine dispatches actual stages.
 * Tests verify Temporal routing is wired correctly and sessions complete.
 *
 * Run: ARK_E2E_STACK_RUNNING=1 bun test e2e/temporal-control-plane.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, copyFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { up as composeUp, down as composeDown } from "./helpers/docker-stack.js";
import { spawnServer, killServer, type ServerHandle } from "./helpers/server-process.js";
import { RpcClient, waitFor } from "./helpers/rpc-client.js";

const REPO_ROOT = resolve(import.meta.dir, "..");
const ENV_FILE = join(REPO_ROOT, ".env.e2e");

let arkDir: string;
let server: ServerHandle;
let rpc: RpcClient;

beforeAll(async () => {
  arkDir = mkdtempSync(join(tmpdir(), "ark-temporal-e2e-"));
  const pluginDir = join(arkDir, "plugins", "executors");
  mkdirSync(pluginDir, { recursive: true });
  copyFileSync(join(REPO_ROOT, "e2e", "fixtures", "stub-runner-executor.mjs"), join(pluginDir, "stub-runner.mjs"));

  // Stack is already up (Temporal server on :7234, Postgres on :15434)
  await composeUp({ scaleTemporal: false });

  server = await spawnServer({
    arkDir,
    envFile: ENV_FILE,
    startupTimeoutMs: 30_000,
    extraEnv: {
      ARK_TEMPORAL_ORCHESTRATION: "true",
      ARK_TEMPORAL_SERVER_URL: "localhost:7234",
      ARK_TEMPORAL_NAMESPACE: "default",
    },
  });
  rpc = new RpcClient(server.webUrl);
  await rpc.call("compute/create", { name: "local", compute: "local", isolation: "direct" }).catch(() => {});
}, 60_000);

afterAll(async () => {
  if (server) await killServer(server);
  await composeDown();
  if (arkDir) rmSync(arkDir, { recursive: true, force: true });
}, 30_000);

// ── T1: Temporal routing assertions ────────────────────────────────────────
//
// Phase 2 design: SessionService.start() in Temporal mode kicked BOTH the
// Temporal workflow AND the bespoke dispatch engine, so the session completed
// via bespoke. T1 used to assert "completed via bespoke engine".
//
// Phase 3 cutover: emitSessionCreated() is gated on !usesTemporal. The
// Temporal workflow is now the sole driver. Until Phase 3.5 ports the
// AppContext-dependent dispatch helpers (getStage, resolveAgent, buildTask,
// executeAction, etc.) into OrchestrationDeps, dispatchStageActivity throws
// at the stubbed-callback boundary and sessions cannot complete end-to-end.
//
// T1's Phase 3 contract: routing stamps + workflow_run_id correlation. The
// completion assertion lives in T1.5 (deferred to Phase 3.5).

describe("T1 -- Temporal routing", () => {
  test(
    "session stamped orchestrator=temporal + workflow_id + workflow_run_id at start",
    async () => {
      const { session: created } = await rpc.call<{ session: any }>("session/start", {
        flow: "e2e-docs",
        summary: "T1-temporal-routing",
      });

      // Routing: set at session creation time, no worker needed
      expect(created.orchestrator).toBe("temporal");
      expect(created.workflow_id).toBeTruthy();
      expect(created.workflow_id).toMatch(/^session-s-/);
      // Phase 3 addition: workflow_run_id is populated from
      // WorkflowHandle.firstExecutionRunId so operators can correlate the
      // session row with the Temporal UI's workflow history.
      expect(created.workflow_run_id).toBeTruthy();
      expect(typeof created.workflow_run_id).toBe("string");
    },
    20_000,
  );
});

// T1.5 -- end-to-end completion under Temporal-driven dispatch.
// Deferred to Phase 3.5: requires porting AppContext-dependent helpers in
// dispatch-deps.ts (getStage, resolveAgent, buildTask, executeAction,
// resolveExecutor, startStatusPoller). See `docs/superpowers/plans/
// 2026-05-08-temporal-phase-3.md` Followups section.
describe("T1.5 -- Temporal-driven completion (Phase 3.5)", () => {
  test.todo("session completes via dispatchStageActivity once dispatch helpers are ported");
});

// ── T2: concurrent routing under Temporal ─────────────────────────────────
//
// Phase 3: assert routing stamps for concurrent starts. Completion under
// Temporal-driven dispatch deferred to Phase 3.5 (see T1.5).

describe("T2 -- concurrent Temporal routing", () => {
  test(
    "concurrent session starts each get distinct workflow_id and workflow_run_id",
    async () => {
      const starts = await Promise.all(
        Array.from({ length: 3 }, (_, i) =>
          rpc.call<{ session: any }>("session/start", { flow: "e2e-docs", summary: `T2-concurrent-${i}` }),
        ),
      );

      const sessions = starts.map((s) => s.session);
      const wfIds = new Set(sessions.map((s) => s.workflow_id));
      const runIds = new Set(sessions.map((s) => s.workflow_run_id));

      expect(wfIds.size).toBe(3);
      expect(runIds.size).toBe(3);
      for (const s of sessions) {
        expect(s.orchestrator).toBe("temporal");
        expect(s.workflow_id).toMatch(/^session-s-/);
        expect(s.workflow_run_id).toBeTruthy();
      }
    },
    30_000,
  );
});

// ── T3-T5: deferred to Phase 3.5 ────────────────────────────────────────────
//
// T3 (manual gate across server restart), T4 (fan-out / join race), and T5
// (retry policy + non-retryable) all require dispatchStageActivity to drive
// real launches. Phase 3 ships the workflow scaffolding (review_gate signals,
// fan_out + stageWorkflow children, ApplicationFailure-tagged errors) but
// the dispatch chain still throws at the stubbed-callback boundary in
// buildDispatchDeps. Phase 3.5 ports the AppContext-dependent helpers and
// these tests light up.

describe("T3 -- manual gate across server restart (Phase 3.5)", () => {
  test.todo("review_gate parks via condition() + signal -- needs dispatch helper port");
});

describe("T4 -- fan-out / join race (Phase 3.5)", () => {
  test.todo("stageWorkflow children + Promise.all -- needs dispatch helper port");
});

describe("T5 -- retry policy + non-retryable (Phase 3.5)", () => {
  test.todo("flaky-pr action wired in core -- needs Temporal activity to reach action layer");
});
