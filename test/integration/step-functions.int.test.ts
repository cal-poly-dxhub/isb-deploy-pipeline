/**
 * v1.3 workflow and account-cleanup health tests.
 *
 * v1.3 no longer uses an AccountCleaner Step Functions state machine. Account
 * cleanup is orchestrated by a durable Lambda; the remaining Step Functions
 * workflows handle assignments, blueprints, and tag activation.
 */
import {
  DescribeStateMachineCommand,
  ListExecutionsCommand,
  ListStateMachinesCommand,
  SFNClient,
} from "@aws-sdk/client-sfn";
import { GetFunctionCommand, LambdaClient } from "@aws-sdk/client-lambda";

import { loadIntegrationEnv } from "./support/test-env";

jest.setTimeout(120_000);

const env = loadIntegrationEnv();

const WORKFLOW_NAMES = [
  "AssignmentProcessor",
  "BlueprintDeployment",
  "TagActivation",
];

type Workflow = {
  name: string;
  stateMachineArn: string;
};

describe("v1.3 workflows and account cleanup", () => {
  const sfn = new SFNClient({ region: env.hubRegion });
  const lambda = new LambdaClient({ region: env.hubRegion });
  let workflows: Workflow[] = [];

  beforeAll(async () => {
    let nextToken: string | undefined;
    do {
      const response = await sfn.send(
        new ListStateMachinesCommand({ nextToken }),
      );
      workflows.push(
        ...(response.stateMachines ?? [])
          .filter(
            (machine) =>
              machine.name &&
              machine.stateMachineArn &&
              WORKFLOW_NAMES.some((name) => machine.name!.includes(name)),
          )
          .map((machine) => ({
            name: machine.name!,
            stateMachineArn: machine.stateMachineArn!,
          })),
      );
      nextToken = response.nextToken;
    } while (nextToken);
  });

  it("has the v1.3 durable account-cleanup Lambda", async () => {
    const functionName = `ISB-DurableCleanupOrchestrationLambda-${env.namespace}`;
    const response = await lambda.send(
      new GetFunctionCommand({ FunctionName: functionName }),
    );
    expect(response.Configuration?.FunctionName).toBe(functionName);
    expect(response.Configuration?.State).toBe("Active");
  });

  it("has at least one v1.3 workflow state machine", () => {
    expect(workflows.length).toBeGreaterThan(0);
  });

  it.each(WORKFLOW_NAMES)(
    "%s workflow is ACTIVE when deployed",
    async (workflowName) => {
      const matching = workflows.filter((workflow) =>
        workflow.name.includes(workflowName),
      );
      for (const workflow of matching) {
        const response = await sfn.send(
          new DescribeStateMachineCommand({
            stateMachineArn: workflow.stateMachineArn,
          }),
        );
        expect(response.status).toBe("ACTIVE");
      }
    },
  );

  it("does not have a 100% failure rate over recent workflow executions", async () => {
    for (const workflow of workflows) {
      const response = await sfn.send(
        new ListExecutionsCommand({
          stateMachineArn: workflow.stateMachineArn,
          maxResults: 20,
        }),
      );
      const executions = response.executions ?? [];
      if (executions.length === 0) continue;
      const failed = executions.filter(
        (execution) =>
          execution.status === "FAILED" || execution.status === "TIMED_OUT",
      ).length;
      expect(failed / executions.length).toBeLessThan(1);
    }
  });
});
