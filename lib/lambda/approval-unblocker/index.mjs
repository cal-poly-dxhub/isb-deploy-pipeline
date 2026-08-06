/**
 * Releases a stage lock held by a stale manual approval.
 *
 * CodePipeline's SUPERSEDED mode only supersedes executions *between* stages
 * (Rule 3 in "How executions are processed in SUPERSEDED mode"). An execution
 * parked on a manual approval is *inside* a stage and holds its lock, so newer
 * executions pile up as inbound and can never overtake it. The stage stays
 * locked until the approval is approved, rejected, or times out after seven
 * days - a timeout AWS does not let you configure.
 *
 * This function restores the intent of SUPERSEDED mode: when a newer execution
 * is in flight, the older execution's pending approval is rejected. Rejecting
 * fails the action, which releases the stage lock, and the waiting execution
 * moves in.
 *
 * It is deliberately conservative:
 *   - only the approval actions listed in APPROVAL_ACTIONS are ever touched;
 *   - an approval is only rejected when a strictly newer execution is still
 *     InProgress, so a lone pending approval keeps waiting for a human;
 *   - nothing is stopped or abandoned, so in-flight CloudFormation deployments
 *     are never interrupted.
 *
 * The AWS SDK v3 is provided by the Lambda Node.js runtime.
 */
import {
  CodePipelineClient,
  GetPipelineStateCommand,
  ListPipelineExecutionsCommand,
  PutApprovalResultCommand,
} from '@aws-sdk/client-codepipeline';

import { findPendingApprovals, selectApprovalsToReject } from './select.mjs';

const client = new CodePipelineClient({});

const PIPELINE_NAME = process.env.PIPELINE_NAME;
/** JSON array of { stageName, actionName } this function may reject. */
const APPROVAL_ACTIONS = JSON.parse(process.env.APPROVAL_ACTIONS ?? '[]');

export const handler = async (event) => {
  if (!PIPELINE_NAME) {
    throw new Error('PIPELINE_NAME environment variable is not set');
  }
  if (APPROVAL_ACTIONS.length === 0) {
    console.log('No approval actions configured; nothing to do.');
    return { rejected: [] };
  }

  console.log(
    'Trigger:',
    JSON.stringify({
      detailType: event?.['detail-type'],
      state: event?.detail?.state,
      stage: event?.detail?.stage,
      execution: event?.detail?.['execution-id'],
    }),
  );

  const state = await client.send(
    new GetPipelineStateCommand({ name: PIPELINE_NAME }),
  );
  const pending = findPendingApprovals(state, APPROVAL_ACTIONS);
  if (pending.length === 0) {
    console.log('No pending approvals.');
    return { rejected: [] };
  }

  const executions = await client.send(
    new ListPipelineExecutionsCommand({
      pipelineName: PIPELINE_NAME,
      maxResults: 50,
    }),
  );

  const decisions = selectApprovalsToReject(
    pending,
    executions.pipelineExecutionSummaries ?? [],
  );

  if (decisions.length === 0) {
    console.log(
      'Pending approvals are the newest work in the pipeline; waiting for a human.',
    );
    return { rejected: [] };
  }

  const rejected = [];
  for (const decision of decisions) {
    const summary =
      `Automatically rejected: execution ${decision.unblockedExecutionId} is ` +
      'newer and was blocked behind this approval. Approve the newer execution instead.';

    await client.send(
      new PutApprovalResultCommand({
        pipelineName: PIPELINE_NAME,
        stageName: decision.stageName,
        actionName: decision.actionName,
        token: decision.token,
        result: { status: 'Rejected', summary: summary.slice(0, 512) },
      }),
    );

    console.log(
      `Rejected ${decision.stageName}/${decision.actionName} held by ` +
        `${decision.supersededExecutionId}; unblocking ${decision.unblockedExecutionId}.`,
    );
    rejected.push({
      stageName: decision.stageName,
      actionName: decision.actionName,
      supersededExecutionId: decision.supersededExecutionId,
      unblockedExecutionId: decision.unblockedExecutionId,
    });
  }

  return { rejected };
};
