import { Worker, NativeConnection } from "@temporalio/worker";
import { Connection, Client } from "@temporalio/client";

const conn = await NativeConnection.connect({ address: "localhost:7234" });
const worker = await Worker.create({
  connection: conn,
  namespace: "default",
  taskQueue: "test-wf-exec-queue",
  workflowsPath: new URL("./packages/core/temporal/workflows/session-workflow.ts", import.meta.url).pathname,
  activities: {},
  maxCachedWorkflows: 1,
  maxConcurrentWorkflowTaskPolls: 1,
});

console.log("Worker ready");
const clientConn = await Connection.connect({ address: "localhost:7234" });
const client = new Client({ connection: clientConn, namespace: "default" });

const handle = await client.workflow.start("sessionWorkflow", {
  taskQueue: "test-wf-exec-queue",
  workflowId: "wf-exec-test-" + Date.now(),
  args: [{ sessionId: "s-fake", tenantId: "default", flowName: "e2e-docs" }],
});
console.log("WF started:", handle.workflowId);

const run = worker.run();
const r = await Promise.race([
  handle.result(),
  new Promise((_, j) => setTimeout(() => j(new Error("timeout")), 15000)),
]).catch(e => "ERROR: " + e.message);
console.log("WF RESULT:", r);
worker.shutdown();
await run.catch(() => {});
