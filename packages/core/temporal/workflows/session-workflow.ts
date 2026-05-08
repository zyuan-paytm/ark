import {
  proxyActivities,
  defineSignal,
  setHandler,
  condition,
  workflowInfo,
  startChild,
} from "@temporalio/workflow";
import type * as acts from "../activities/index.js";
import type { SessionWorkflowInput } from "../types.js";
import { stageWorkflow } from "./stage-workflow.js";
import { classifyStage } from "../dag-helpers.js";

const {
  startSessionActivity,
  resolveComputeForStageActivity,
  provisionComputeActivity,
  dispatchStageActivity,
  awaitStageCompletionActivity,
  executeActionActivity: _executeActionActivity,
  runVerificationActivity: _runVerificationActivity,
  projectSessionActivity,
  projectStageActivity,
  loadFlowActivity,
} = proxyActivities<typeof acts>({
  startToCloseTimeout: "1 hour",
  heartbeatTimeout: "60 seconds",
  retry: { maximumAttempts: 3, initialInterval: "1s", backoffCoefficient: 2 },
});

export const approveReviewGateSignal = defineSignal<[{ sessionId: string }]>("approveReviewGate");
export const rejectReviewGateSignal = defineSignal<[{ sessionId: string; reason: string }]>("rejectReviewGate");

export async function sessionWorkflow(input: SessionWorkflowInput): Promise<void> {
  let approved = false;
  let rejected: string | null = null;

  setHandler(approveReviewGateSignal, () => {
    approved = true;
  });
  setHandler(rejectReviewGateSignal, (p) => {
    rejected = p.reason;
  });

  const seq = () => workflowInfo().historyLength;

  const mode = input.shadowMode ? ("shadow" as const) : ("real" as const);

  await startSessionActivity(input);
  await projectSessionActivity({ sessionId: input.sessionId, seq: seq(), patch: { status: "ready" }, mode });

  const flow = await loadFlowActivity({ flowName: input.flowName });

  for (const stageIdx of flow.topoOrder) {
    const stage = flow.stages[stageIdx];
    const kind = classifyStage(stage);

    // Review gate: park on signal -- durable across worker / server restart.
    if (kind === "review_gate") {
      await projectStageActivity({
        sessionId: input.sessionId,
        stageIdx,
        seq: seq(),
        patch: { status: "awaiting_review" },
        mode,
      });
      await condition(() => approved || rejected !== null);
      if (rejected !== null) {
        await projectStageActivity({
          sessionId: input.sessionId,
          stageIdx,
          seq: seq(),
          patch: { status: "rejected", error: rejected },
          mode,
        });
        await projectSessionActivity({
          sessionId: input.sessionId,
          seq: seq(),
          patch: { status: "failed", error: rejected },
          mode,
        });
        return;
      }
      approved = false; // reset for next gate
      await projectStageActivity({
        sessionId: input.sessionId,
        stageIdx,
        seq: seq(),
        patch: { status: "completed" },
        mode,
      });
      continue;
    }

    // Fan-out: spawn child stageWorkflow instances in parallel, join via Promise.all.
    if (kind === "fan_out") {
      const subtasks: any[] = (stage as any).subtasks ?? [];
      await projectStageActivity({
        sessionId: input.sessionId,
        stageIdx,
        seq: seq(),
        patch: { status: "fanning_out" },
        mode,
      });
      const childPromises = subtasks.map((sub: any, j: number) =>
        startChild(stageWorkflow, {
          workflowId: `${input.sessionId}-${stage.name}-${j}`,
          taskQueue: workflowInfo().taskQueue,
          args: [
            {
              parentSessionId: input.sessionId,
              childSessionId: sub.sessionId ?? `${input.sessionId}-${stage.name}-${j}`,
              tenantId: input.tenantId,
              stageIdx,
              stageName: stage.name,
              task: sub.task ?? "",
              agent: sub.agent,
            },
          ],
        }).then((handle) => handle.result()),
      );
      const results = await Promise.all(childPromises);
      const failed = results.find((r) => r.status !== "completed");
      await projectStageActivity({
        sessionId: input.sessionId,
        stageIdx,
        seq: seq(),
        patch: { status: failed ? "failed" : "completed" },
        mode,
      });
      if (failed) {
        await projectSessionActivity({
          sessionId: input.sessionId,
          seq: seq(),
          patch: { status: "failed" },
          mode,
        });
        return;
      }
      continue;
    }

    // Linear/DAG stage: dispatch + await completion.
    await resolveComputeForStageActivity({ sessionId: input.sessionId, stageIdx });
    await provisionComputeActivity({ sessionId: input.sessionId, computeName: "local" });
    await projectStageActivity({
      sessionId: input.sessionId,
      stageIdx,
      seq: seq(),
      patch: { status: "dispatching" },
      mode,
    });

    const launch = await dispatchStageActivity({ sessionId: input.sessionId, stageIdx });
    await projectStageActivity({
      sessionId: input.sessionId,
      stageIdx,
      seq: seq(),
      patch: { status: "running", ...launch },
      mode,
    });

    const result = await awaitStageCompletionActivity({
      sessionId: input.sessionId,
      stageIdx,
      timeoutMs: 3_600_000,
    });
    await projectStageActivity({
      sessionId: input.sessionId,
      stageIdx,
      seq: seq(),
      patch: { status: result.status },
      mode,
    });

    if (result.status !== "completed") {
      await projectSessionActivity({
        sessionId: input.sessionId,
        seq: seq(),
        patch: { status: result.status },
        mode,
      });
      return;
    }
  }

  await projectSessionActivity({
    sessionId: input.sessionId,
    seq: seq(),
    patch: { status: "completed" },
    mode,
  });
}
