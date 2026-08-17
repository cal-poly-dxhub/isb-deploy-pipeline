/**
 * Exercises the approval unblocker's decision logic.
 *
 * Run as a child process by test/approval-unblocker.test.ts because the module
 * under test is ESM (.mjs) while the Jest projects are CommonJS. Keeping the
 * logic import-free means no mocking is required.
 *
 * Exits non-zero with a readable message on the first failed assertion.
 */
import assert from 'node:assert/strict';

import {
  findPendingApprovals,
  selectApprovalsToReject,
} from '../../lib/lambda/approval-unblocker/select.mjs';

const MANAGED = [
  { stageName: 'Dev', actionName: 'Approve-Dev' },
  { stageName: 'Prod', actionName: 'Approve-Prod' },
];

const approval = (id) => ({
  stageName: 'Dev',
  actionName: 'Approve-Dev',
  token: 'tok-1',
  pipelineExecutionId: id,
});

// --- selectApprovalsToReject ------------------------------------------------

// A newer in-flight execution is blocked behind the approval -> reject it.
assert.deepEqual(
  selectApprovalsToReject(
    [approval('exec-old')],
    [
      { pipelineExecutionId: 'exec-new', status: 'InProgress' },
      { pipelineExecutionId: 'exec-old', status: 'InProgress' },
    ],
  ),
  [
    {
      stageName: 'Dev',
      actionName: 'Approve-Dev',
      token: 'tok-1',
      supersededExecutionId: 'exec-old',
      unblockedExecutionId: 'exec-new',
    },
  ],
  'should reject an approval that is blocking a newer in-flight execution',
);

// The approval is the newest thing in the pipeline -> leave it for a human.
assert.deepEqual(
  selectApprovalsToReject(
    [approval('exec-newest')],
    [
      { pipelineExecutionId: 'exec-newest', status: 'InProgress' },
      { pipelineExecutionId: 'exec-older', status: 'Succeeded' },
    ],
  ),
  [],
  'should never reject the newest execution just because older ones exist',
);

// Newer executions exist but none are in flight -> nothing is being blocked.
assert.deepEqual(
  selectApprovalsToReject(
    [approval('exec-old')],
    [
      { pipelineExecutionId: 'exec-new', status: 'Superseded' },
      { pipelineExecutionId: 'exec-old', status: 'InProgress' },
    ],
  ),
  [],
  'should not reject when the newer executions are no longer in flight',
);

// The holding execution has aged out of the returned history -> do not guess.
assert.deepEqual(
  selectApprovalsToReject(
    [approval('exec-unknown')],
    [{ pipelineExecutionId: 'exec-new', status: 'InProgress' }],
  ),
  [],
  'should not act when the approval holder is absent from recent history',
);

// Picks the newest blocked execution when several are queued.
assert.equal(
  selectApprovalsToReject(
    [approval('exec-old')],
    [
      { pipelineExecutionId: 'exec-c', status: 'InProgress' },
      { pipelineExecutionId: 'exec-b', status: 'InProgress' },
      { pipelineExecutionId: 'exec-old', status: 'InProgress' },
    ],
  )[0].unblockedExecutionId,
  'exec-c',
  'should report the newest blocked execution',
);

// --- findPendingApprovals ---------------------------------------------------

const state = {
  stageStates: [
    {
      stageName: 'Dev',
      latestExecution: { pipelineExecutionId: 'exec-old' },
      actionStates: [
        {
          actionName: 'Approve-Dev',
          latestExecution: { status: 'InProgress', token: 'tok-dev' },
        },
      ],
    },
    {
      stageName: 'Prod',
      latestExecution: { pipelineExecutionId: 'exec-old' },
      actionStates: [
        // Already answered - must not be picked up.
        {
          actionName: 'Approve-Prod',
          latestExecution: { status: 'Succeeded', token: 'tok-prod' },
        },
      ],
    },
    {
      stageName: 'Dev',
      latestExecution: { pipelineExecutionId: 'exec-old' },
      actionStates: [
        // In progress but not an approval action (no token) - must be ignored.
        {
          actionName: 'Deploy-Dev-data',
          latestExecution: { status: 'InProgress' },
        },
      ],
    },
  ],
};

assert.deepEqual(
  findPendingApprovals(state, MANAGED),
  [
    {
      stageName: 'Dev',
      actionName: 'Approve-Dev',
      token: 'tok-dev',
      pipelineExecutionId: 'exec-old',
    },
  ],
  'should find only in-progress approvals from the managed action list',
);

// An action that is pending but NOT in the managed list is never touched.
assert.deepEqual(
  findPendingApprovals(state, [
    { stageName: 'Staging', actionName: 'Approve-Staging' },
  ]),
  [],
  'should ignore approvals outside the configured action list',
);

assert.deepEqual(findPendingApprovals({}, MANAGED), []);

console.log('approval unblocker decision logic: all assertions passed');
