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

// ── T1: Temporal routing + session completion ──────────────────────────────
//
// Phase 2 design: SessionService.start() in Temporal mode:
//   1. Starts the Temporal workflow (records workflow_id + orchestrator=temporal)
//   2. ALSO kicks the bespoke dispatch engine so stages actually run
//
// The Temporal workflow watches for completion in the background.
// T1 proves the routing decision is correct AND the session completes.

describe("T1 -- Temporal routing and session completion", () => {
  test(
    "session stamped orchestrator=temporal+workflow_id and completes via bespoke engine",
    async () => {
      const { session: created } = await rpc.call<{ session: any }>("session/start", {
        flow: "e2e-docs",
        summary: "T1-temporal-routing",
      });

      // Routing assertion: set at session creation time, no worker needed
      expect(created.orchestrator).toBe("temporal");
      expect(created.workflow_id).toBeTruthy();
      expect(created.workflow_id).toMatch(/^session-s-/);

      // Completion assertion: bespoke engine runs stages, session reaches terminal state
      const result = await waitFor(
        () => rpc.call<{ session: any }>("session/read", { sessionId: created.id }),
        (r) => ["completed", "failed"].includes(r.session.status),
        { timeoutMs: 30_000, intervalMs: 500, description: "T1 session terminal" },
      );

      if (result.session.status !== "completed") {
        console.error("T1: session did not complete:", JSON.stringify(result.session, null, 2));
      }

      expect(result.session.status).toBe("completed");
      // Temporal markers persist through completion
      expect(result.session.orchestrator).toBe("temporal");
      expect(result.session.workflow_id).toBeTruthy();
    },
    40_000,
  );
});

// ── T2: Temporal routing + bespoke parity ─────────────────────────────────

describe("T2 -- bespoke sessions unaffected when Temporal flag is on globally", () => {
  test(
    "sessions with orchestrator=temporal still complete at same rate as before",
    async () => {
      // Start 3 sessions concurrently -- all use Temporal routing (flag is global)
      const starts = await Promise.all(
        Array.from({ length: 3 }, (_, i) =>
          rpc.call<{ session: any }>("session/start", { flow: "e2e-docs", summary: `T2-concurrent-${i}` }),
        ),
      );

      const ids = starts.map((s) => s.session.id);

      // All three must complete within 30s
      const results = await Promise.all(
        ids.map((id) =>
          waitFor(
            () => rpc.call<{ session: any }>("session/read", { sessionId: id }),
            (r) => ["completed", "failed"].includes(r.session.status),
            { timeoutMs: 30_000, intervalMs: 500, description: `T2 session ${id}` },
          ),
        ),
      );

      for (const r of results) {
        expect(r.session.status).toBe("completed");
        expect(r.session.orchestrator).toBe("temporal");
      }
    },
    45_000,
  );
});

// ── T3-T5: stub placeholders ───────────────────────────────────────────────

describe("T3 -- manual gate (requires workflow task execution)", () => {
  test.todo("Temporal worker workflow task execution needs Node.js or updated Bun SDK");
});

describe("T4 -- fan-out / join race", () => {
  test.todo("requires fan_out stage type (Phase 3)");
});

describe("T5 -- retry policy + non-retryable errors", () => {
  test.todo("requires flaky-pr test action");
});
