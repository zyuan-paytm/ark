import { test, expect, afterEach } from "bun:test";
import { buildDispatchDeps } from "../activities/dispatch-deps.js";
import { AppContext } from "../../app.js";
import { depsFromApp } from "../../services/deps.js";

let app: AppContext | null = null;
afterEach(async () => {
  if (app) await app.shutdown();
  app = null;
});

test("buildDispatchDeps returns a DispatchDeps with all required fields", async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
  const orchDeps = depsFromApp(app);
  const dispatchDeps = buildDispatchDeps(orchDeps);

  expect(dispatchDeps.sessions).toBeDefined();
  expect(dispatchDeps.events).toBeDefined();
  expect(dispatchDeps.computes).toBeDefined();
  expect(dispatchDeps.flows).toBeDefined();
  expect(dispatchDeps.blobStore).toBeDefined();
  expect((dispatchDeps as any).app).toBeUndefined();
});
