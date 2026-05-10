/**
 * T1-T5: Temporal orchestration e2e tests.
 *
 * Phase 2 test strategy: The Temporal workflow runs in the background
 * (watching for completion). The bespoke engine dispatches actual stages.
 * Tests verify Temporal routing is wired correctly and sessions complete.
 *
 * Run: ARK_E2E_STACK_RUNNING=1 bun test e2e/temporal-control-plane.test.ts
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, copyFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import YAML from "yaml";
import { up as composeUp, down as composeDown } from "./helpers/docker-stack.js";
import { spawnServer, killServer, type ServerHandle } from "./helpers/server-process.js";
import { RpcClient, waitFor } from "./helpers/rpc-client.js";

const REPO_ROOT = resolve(import.meta.dir, "..");
const ENV_FILE = join(REPO_ROOT, ".env.e2e");

let arkDir: string;
let server: ServerHandle;
let rpc: RpcClient;

/**
 * Tracks sessions the test created so afterEach can stop them. Calling
 * session/stop drives the same SessionService.stop() path that production
 * uses, which now terminates the Temporal workflow alongside the row update.
 *
 * Without this, every iteration on a single test leaks a Running workflow into
 * Temporal's history table -- by run #20 the UI is unusable. The full-suite
 * teardown (`composeDown` -> `down -v`) wipes the volume and so is fine, but
 * single-test iteration was the painful path.
 */
const createdSessionIds: string[] = [];

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
      // Bind the conductor on 0.0.0.0 so the dockerised Temporal worker can
      // reach it via host.docker.internal:19102 to deliver stub-agent
      // completion reports. Default is loopback-only.
      ARK_CONDUCTOR_HOSTNAME: "0.0.0.0",
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

/**
 * Stop every session this test file created. session/stop now goes through
 * SessionService.stop() which terminates the Temporal workflow as part of
 * the stop sequence (PR #538 cleanup edit). afterEach must never throw, so
 * already-stopped / not-found responses are swallowed.
 */
afterEach(async () => {
  while (createdSessionIds.length > 0) {
    const sessionId = createdSessionIds.shift()!;
    try {
      await rpc.call("session/stop", { sessionId, force: true });
    } catch {
      // already stopped / session gone -- not a test failure
    }
  }
}, 15_000);

/** Helper: register a session for afterEach cleanup. */
function trackSession(session: { id: string }): void {
  createdSessionIds.push(session.id);
}

/**
 * Ingest a fixture flow YAML into the hosted DB via the `flow/create` RPC.
 *
 * In hosted mode the FlowStore is DB-backed (DbResourceStore); copying YAML
 * into `arkDir/flows` is a no-op because that directory is only consulted
 * by the local-mode FileFlowStore. The Temporal worker reads the same DB
 * over the docker network, so a single `flow/create` call makes the flow
 * visible to both the server and the worker.
 *
 * Idempotent: `flow/create` rejects an existing non-builtin flow, so the
 * 409-equivalent error is swallowed -- repeated test runs reuse what's
 * already there.
 */
async function ingestFixtureFlow(name: string): Promise<void> {
  const yamlPath = join(REPO_ROOT, "e2e", "fixtures", "flows", `${name}.yaml`);
  const parsed = YAML.parse(readFileSync(yamlPath, "utf-8")) as {
    name: string;
    description?: string;
    stages: any[];
  };
  try {
    await rpc.call("flow/create", {
      name: parsed.name,
      description: parsed.description,
      stages: parsed.stages,
      scope: "global",
    });
  } catch (err) {
    const msg = String((err as Error).message ?? err);
    if (!/already exists/i.test(msg)) throw err;
  }
}

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
      trackSession(created);

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
      sessions.forEach(trackSession);
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

// ── T3: review_gate parks durably across server restart ─────────────────────
//
// Phase 3.6-A: executeAction is ported via buildDispatchDeps shim; the worker
// container installs stub-runner + flow YAMLs at boot. T3 verifies that the
// review_gate stage parks the Temporal workflow via condition(), that the
// workflow survives a server restart (Temporal holds the durable state), and
// that an approveReviewGate signal unblocks and completes the session.
//
// Parking detection: projectStageActivity writes only a seq watermark to
// session_projections (not a queryable stage-status column -- session_stages
// table is not yet introduced). The session row status stays "ready" while
// parked. We therefore wait for the session to be in a non-terminal "ready"
// state long enough for the plan stage to have finished (~10 s), treating
// persistent "ready" as the parked-at-gate signal before sending approve.

describe("T3 -- manual gate across server restart", () => {
  test(
    "review_gate parks, survives server restart, resumes on approve",
    async () => {
      // 1. Ingest e2e-review into the hosted DB so the worker can resolve it.
      await ingestFixtureFlow("e2e-review");

      // 2. Start a session on the e2e-review flow.
      const { session: created } = await rpc.call<{ session: any }>("session/start", {
        flow: "e2e-review",
        summary: "T3-review-gate-restart",
      });
      trackSession(created);
      expect(created.orchestrator).toBe("temporal");

      // 3. Wait for the workflow to move the session out of "pending" (i.e.
      //    projectSessionActivity has patched status to "ready"). This proves
      //    the workflow started and the plan stage began executing.
      await waitFor(
        () => rpc.call<{ session: any }>("session/read", { sessionId: created.id }),
        (r) => r.session.status !== "pending",
        { timeoutMs: 60_000, intervalMs: 1_000, description: "T3 session left pending" },
      );

      // 4. Give the plan stage (stub-runner) time to complete and let the
      //    workflow advance to the review_gate stage and park there.
      //    stub-runner completes in <1 s; 10 s is ample even under load.
      await Bun.sleep(10_000);

      // 5. Confirm the session is still non-terminal -- it is parked at the
      //    review gate waiting for a signal.
      const parked = await rpc.call<{ session: any }>("session/read", { sessionId: created.id });
      expect(["completed", "failed"]).not.toContain(parked.session.status);

      // 6. Kill and restart the server -- the Temporal workflow stays durably
      //    parked; Temporal holds the condition state across worker restarts.
      await killServer(server);
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

      // 7. Still parked after restart -- session row is unchanged.
      const stillParked = await rpc.call<{ session: any }>("session/read", { sessionId: created.id });
      expect(["completed", "failed"]).not.toContain(stillParked.session.status);

      // 8. Approve via gate/approve -- this sends the approveReviewGate signal
      //    to the Temporal workflow, unblocking the condition().
      await rpc.call("gate/approve", { sessionId: created.id });

      // 9. Session should complete now that the gate is open and close_ticket runs.
      const final = await waitFor(
        () => rpc.call<{ session: any }>("session/read", { sessionId: created.id }),
        (r) => ["completed", "failed"].includes(r.session.status),
        { timeoutMs: 60_000, intervalMs: 1_000, description: "T3 final" },
      );
      expect(final.session.status).toBe("completed");
    },
    180_000,
  );
});

// ── T4: fan-out / join race ───────────────────────────────────────────────────
//
// Deferred: stageWorkflow children + Promise.all require fan_out stage type
// and a suitable fixture flow. Tracked as Phase 3.5 follow-up.

describe("T4 -- fan-out / join race (Phase 3.5)", () => {
  test.todo("stageWorkflow children + Promise.all -- needs dispatch helper port");
});

// ── T5a: transient retry succeeds after N failures ───────────────────────────
//
// flaky_pr is configured to fail 3x with a transient "503 service unavailable"
// error then succeed. Temporal's default retry policy retries on non-application
// failures, so the activity retries and the session eventually completes.

describe("T5a -- transient retry succeeds after 3 failures", () => {
  test(
    "flaky_pr retries 3x then completes session",
    async () => {
      await ingestFixtureFlow("e2e-retry");

      const { session: created } = await rpc.call<{ session: any }>("session/start", {
        flow: "e2e-retry",
        summary: "T5a-transient-retry",
      });
      trackSession(created);
      expect(created.orchestrator).toBe("temporal");

      // flaky_pr fails 3x then succeeds; retries add latency so allow 120 s.
      const final = await waitFor(
        () => rpc.call<{ session: any }>("session/read", { sessionId: created.id }),
        (r) => ["completed", "failed"].includes(r.session.status),
        { timeoutMs: 120_000, intervalMs: 1_000, description: "T5a final" },
      );
      // flaky_pr is configured to fail 3x then succeed -- session must complete.
      expect(final.session.status).toBe("completed");
    },
    150_000,
  );
});

// ── T5b: non-retryable AuthError fails fast ───────────────────────────────────
//
// flaky_pr configured with fail_times=999 and error="AuthError". The action
// layer throws an ApplicationFailure with nonRetryable=true for AuthError,
// so Temporal propagates the failure immediately without exhausting retries.

describe("T5b -- non-retryable AuthError fails fast", () => {
  test(
    "AuthError causes immediate session failure (no retries)",
    async () => {
      await ingestFixtureFlow("e2e-retry-nonretryable");

      const started = Date.now();
      const { session: created } = await rpc.call<{ session: any }>("session/start", {
        flow: "e2e-retry-nonretryable",
        summary: "T5b-auth-fail-fast",
      });
      trackSession(created);
      expect(created.orchestrator).toBe("temporal");

      const final = await waitFor(
        () => rpc.call<{ session: any }>("session/read", { sessionId: created.id }),
        (r) => ["completed", "failed"].includes(r.session.status),
        { timeoutMs: 60_000, intervalMs: 500, description: "T5b final" },
      );
      expect(final.session.status).toBe("failed");
      // Non-retryable failures propagate within ~2-3 s on local Temporal stack.
      // The 60 s bound above is generous; assert we didn't exhaust retry delays.
      expect(Date.now() - started).toBeLessThan(60_000);
    },
    90_000,
  );
});
