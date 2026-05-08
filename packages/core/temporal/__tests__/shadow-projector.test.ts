import { test, expect, beforeAll, afterAll } from "bun:test";
import {
  projectSessionActivity,
  injectDeps as injectProjectSessionDeps,
} from "../activities/project-session.js";
import {
  projectStageActivity,
  injectDeps as injectProjectStageDeps,
} from "../activities/project-stage.js";
import { AppContext } from "../../app.js";
import { depsFromApp } from "../../services/deps.js";

let app: AppContext;
beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});
afterAll(async () => {
  await app?.shutdown();
});

test("projectSessionActivity in shadow mode writes to session_projections_shadow", async () => {
  const deps = depsFromApp(app);
  injectProjectSessionDeps(deps);

  const session = await app.sessions.create({ flow: "e2e-docs", summary: "shadow-1" });

  await projectSessionActivity({
    sessionId: session.id,
    seq: 1,
    patch: { status: "completed" },
    mode: "shadow",
  });

  // Live sessions row should NOT be updated.
  const row = await app.sessions.get(session.id);
  expect(row?.status).not.toBe("completed");

  // Shadow row should exist with the patch stored as JSON.
  const shadowRow = (await (app.db as any)
    .prepare("SELECT * FROM session_projections_shadow WHERE session_id=? AND stage_idx IS NULL")
    .get(session.id)) as { session_id: string; last_seq: number; patch_json: string } | undefined;
  expect(shadowRow).toBeTruthy();
  expect(shadowRow!.last_seq).toBe(1);
  const patch = JSON.parse(shadowRow!.patch_json);
  expect(patch.status).toBe("completed");
});

test("projectSessionActivity in real mode (default) writes to live tables", async () => {
  const deps = depsFromApp(app);
  injectProjectSessionDeps(deps);

  const session = await app.sessions.create({ flow: "e2e-docs", summary: "real-1" });

  await projectSessionActivity({
    sessionId: session.id,
    seq: 1,
    patch: { status: "completed" },
  });

  const row = await app.sessions.get(session.id);
  expect(row).toBeTruthy();
  // Watermark row in live projections table should be written.
  const projRow = (await (app.db as any)
    .prepare("SELECT last_seq FROM session_projections WHERE session_id=? AND stage_idx IS NULL")
    .get(session.id)) as { last_seq: number } | undefined;
  expect(projRow).toBeTruthy();
  expect(projRow!.last_seq).toBe(1);
});

test("projectStageActivity in shadow mode writes to session_projections_shadow", async () => {
  const deps = depsFromApp(app);
  injectProjectStageDeps(deps);

  const session = await app.sessions.create({ flow: "e2e-docs", summary: "shadow-stage-1" });

  await projectStageActivity({
    sessionId: session.id,
    stageIdx: 0,
    seq: 1,
    patch: { status: "dispatching" },
    mode: "shadow",
  });

  // Shadow row should exist for stage_idx=0.
  const shadowRow = (await (app.db as any)
    .prepare("SELECT * FROM session_projections_shadow WHERE session_id=? AND stage_idx=?")
    .get(session.id, 0)) as { session_id: string; last_seq: number; patch_json: string } | undefined;
  expect(shadowRow).toBeTruthy();
  expect(shadowRow!.last_seq).toBe(1);
  const patch = JSON.parse(shadowRow!.patch_json);
  expect(patch.status).toBe("dispatching");

  // Live session_projections should NOT have a row for this stage.
  const liveRow = (await (app.db as any)
    .prepare("SELECT last_seq FROM session_projections WHERE session_id=? AND stage_idx=?")
    .get(session.id, 0)) as { last_seq: number } | undefined;
  expect(liveRow).toBeUndefined();
});

test("projectStageActivity in real mode (default) writes to live tables", async () => {
  const deps = depsFromApp(app);
  injectProjectStageDeps(deps);

  const session = await app.sessions.create({ flow: "e2e-docs", summary: "real-stage-1" });

  await projectStageActivity({
    sessionId: session.id,
    stageIdx: 0,
    seq: 1,
    patch: { status: "completed" },
  });

  const projRow = (await (app.db as any)
    .prepare("SELECT last_seq FROM session_projections WHERE session_id=? AND stage_idx=?")
    .get(session.id, 0)) as { last_seq: number } | undefined;
  expect(projRow).toBeTruthy();
  expect(projRow!.last_seq).toBe(1);
});

test("shadow mode idempotency -- second call with same seq is a no-op", async () => {
  const deps = depsFromApp(app);
  injectProjectSessionDeps(deps);

  const session = await app.sessions.create({ flow: "e2e-docs", summary: "shadow-idem" });

  await projectSessionActivity({
    sessionId: session.id,
    seq: 5,
    patch: { status: "completed" },
    mode: "shadow",
  });

  // Second call with same seq -- should be a no-op (last_seq stays 5).
  await projectSessionActivity({
    sessionId: session.id,
    seq: 5,
    patch: { status: "failed" },
    mode: "shadow",
  });

  const shadowRow = (await (app.db as any)
    .prepare("SELECT patch_json FROM session_projections_shadow WHERE session_id=? AND stage_idx IS NULL")
    .get(session.id)) as { patch_json: string } | undefined;
  const patch = JSON.parse(shadowRow!.patch_json);
  // Should still be "completed" -- second write was rejected.
  expect(patch.status).toBe("completed");
});
