import { Context } from "@temporalio/activity";
import type { StageCompletionResult } from "../types.js";
import type { OrchestrationDeps } from "../../services/deps.js";

let _deps: OrchestrationDeps | null = null;
export function injectDeps(deps: OrchestrationDeps): void {
  _deps = deps;
}
function deps(): OrchestrationDeps {
  if (!_deps) throw new Error("awaitStageCompletionActivity: deps not injected");
  return _deps;
}

/**
 * Poll the sessions table until the session reaches a terminal state.
 * Heartbeats every poll interval so the Temporal server knows the activity is alive.
 */
export async function awaitStageCompletionActivity(input: {
  sessionId: string;
  stageIdx: number;
  timeoutMs?: number;
}): Promise<StageCompletionResult> {
  const d = deps();
  const deadline = Date.now() + (input.timeoutMs ?? 3_600_000);

  const POLL_MS = 500;
  const HEARTBEAT_EVERY = 20; // heartbeat every 20 polls (~10s)
  let pollCount = 0;

  while (Date.now() < deadline) {
    if (pollCount % HEARTBEAT_EVERY === 0) {
      Context.current().heartbeat(`waiting-stage-${input.stageIdx}`);
    }
    pollCount++;

    const session = await d.sessions.get(input.sessionId);
    if (!session) {
      await Bun.sleep(POLL_MS);
      continue;
    }

    const status = session.status as string;
    if (["completed", "failed", "stopped", "archived"].includes(status)) {
      // Map archived -> stopped for the workflow's state machine.
      const mapped: StageCompletionResult["status"] =
        status === "archived" ? "stopped" : (status as StageCompletionResult["status"]);
      return { status: mapped };
    }

    await Bun.sleep(POLL_MS);
  }

  return { status: "failed", error: "awaitStageCompletion timed out" };
}
