/**
 * Pure decision logic for the approval unblocker.
 *
 * Kept free of imports (no AWS SDK, no Node built-ins) so it can be exercised
 * directly by the unit tests without mocking anything.
 */

/**
 * Decides which pending approvals should be rejected to release a stage lock.
 *
 * An approval is only rejected when a strictly newer execution is still in
 * flight, because that is the execution being unfairly blocked. A pending
 * approval that is the newest work in the pipeline is left alone so it can keep
 * waiting for a human.
 *
 * @param {Array<{stageName: string, actionName: string, token: string, pipelineExecutionId: string}>} pendingApprovals
 * @param {Array<{pipelineExecutionId: string, status: string}>} executionsNewestFirst
 *   Execution summaries in the order ListPipelineExecutions returns them
 *   (reverse chronological).
 * @returns {Array<{stageName: string, actionName: string, token: string, supersededExecutionId: string, unblockedExecutionId: string}>}
 */
export function selectApprovalsToReject(
  pendingApprovals,
  executionsNewestFirst,
) {
  const decisions = [];

  for (const approval of pendingApprovals) {
    const holderIndex = executionsNewestFirst.findIndex(
      (e) => e.pipelineExecutionId === approval.pipelineExecutionId,
    );
    if (holderIndex === -1) {
      // The execution holding the approval is not in recent history; do not
      // guess.
      continue;
    }

    // Entries ahead of the holder are strictly newer.
    const newerInFlight = executionsNewestFirst
      .slice(0, holderIndex)
      .filter((e) => e.status === 'InProgress');

    if (newerInFlight.length === 0) {
      continue;
    }

    decisions.push({
      stageName: approval.stageName,
      actionName: approval.actionName,
      token: approval.token,
      supersededExecutionId: approval.pipelineExecutionId,
      unblockedExecutionId: newerInFlight[0].pipelineExecutionId,
    });
  }

  return decisions;
}

/**
 * Extracts the pending approvals this function is allowed to act on from a
 * GetPipelineState response.
 *
 * @param {{stageStates?: Array<object>}} pipelineState
 * @param {Array<{stageName: string, actionName: string}>} managedActions
 */
export function findPendingApprovals(pipelineState, managedActions) {
  const pending = [];
  for (const stage of pipelineState.stageStates ?? []) {
    for (const action of stage.actionStates ?? []) {
      const isManaged = managedActions.some(
        (a) =>
          a.stageName === stage.stageName && a.actionName === action.actionName,
      );
      if (!isManaged) {
        continue;
      }
      const latest = action.latestExecution;
      // A pending approval is InProgress and carries an approval token.
      if (latest?.status !== 'InProgress' || !latest.token) {
        continue;
      }
      pending.push({
        stageName: stage.stageName,
        actionName: action.actionName,
        token: latest.token,
        pipelineExecutionId: stage.latestExecution?.pipelineExecutionId,
      });
    }
  }
  return pending;
}
