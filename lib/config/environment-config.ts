/**
 * Configuration types for Innovation Sandbox deployments.
 *
 * Innovation Sandbox on AWS is a multi-account solution. Each deployment target
 * (dev, staging, prod) requires three logical AWS accounts:
 *
 *   - orgManagement: The AWS Organizations management account where the
 *     AccountPool stack is deployed. This account owns the OUs that hold
 *     sandbox accounts and the SCPs attached to them.
 *
 *   - idc: The IAM Identity Center delegated administrator account where the
 *     IDC stack is deployed. This stack provisions permission sets and groups
 *     used to grant users access to sandbox accounts.
 *
 *   - hub: The "Hub" account where the Data and Compute stacks live. This is
 *     the account that hosts the web UI (CloudFront/S3), API Gateway, Lambdas,
 *     DynamoDB tables, EventBridge rules, Step Functions, and the AWS Nuke
 *     CodeBuild project (with its ECR image).
 *
 * For small (single-account) deployments, all three IDs may be identical.
 */

/**
 * Identifies a single AWS account/region pair.
 */
export interface AwsEnvironment {
  /** 12-digit AWS account ID. */
  readonly account: string;
  /** AWS region (e.g. "us-east-1"). */
  readonly region: string;
}

/**
 * The set of accounts that make up a single Innovation Sandbox deployment.
 */
export interface InnovationSandboxAccounts {
  readonly orgManagement: AwsEnvironment;
  readonly idc: AwsEnvironment;
  readonly hub: AwsEnvironment;
}

/**
 * Configuration for a single named deployment stage (e.g. "dev", "staging",
 * "prod"). The pipeline iterates over a list of these in order.
 */
export interface DeploymentStageConfig {
  /** Friendly name used in pipeline stage and CloudFormation stack names. */
  readonly stageName: string;

  /** The three accounts the solution will be deployed into. */
  readonly accounts: InnovationSandboxAccounts;

  /**
   * If true, a manual approval action is added BEFORE the deploy stage runs.
   * Use this for production / sensitive stages.
   */
  readonly requireManualApproval?: boolean;

  /**
   * Optional list of email addresses that receive an SNS notification when the
   * approval is pending.
   */
  readonly approvalNotificationEmails?: string[];

  /**
   * If true, the pipeline will run a post-deployment integration test step.
   */
  readonly runIntegrationTests?: boolean;

  /**
   * Optional override for the upstream environment file. These values are
   * written into the CodeBuild environment when running `npm run deploy:*`
   * commands. Keys correspond to the variables documented in the upstream
   * `.env.example`.
   */
  readonly envOverrides?: Record<string, string>;
}

/**
 * Configuration for a GitHub source repository.
 */
export interface SourceConfig {
  /** GitHub owner (org or user). */
  readonly owner: string;
  /** Repository name. */
  readonly repo: string;
  /** Branch to track. */
  readonly branch: string;
  /**
   * Name of the AWS Secrets Manager secret holding a GitHub personal access
   * token with `repo` and `admin:repo_hook` scopes.
   */
  readonly connectionSecretName?: string;
  /**
   * Alternatively, the ARN of an AWS CodeStar Connections connection
   * (preferred). If set, the pipeline uses CodeStar Connections instead of
   * a GitHub OAuth token.
   */
  readonly codestarConnectionArn?: string;
}

/**
 * Top-level pipeline configuration consumed by the PipelineStack.
 */
export interface PipelineConfig {
  /** Name used for the CodePipeline resource. */
  readonly pipelineName: string;

  /** Account/region the pipeline itself lives in (the "tooling" account). */
  readonly toolingEnv: AwsEnvironment;

  /** Where to pull upstream Innovation Sandbox source from. */
  readonly source: SourceConfig;

  /** Where to pull this pipeline's own source from (for self-mutation). */
  readonly pipelineSource: SourceConfig;

  /**
   * Ordered list of deployment stages. The pipeline executes them sequentially,
   * with optional manual approvals in between.
   */
  readonly stages: DeploymentStageConfig[];

  /**
   * Optional SNS topic ARN that receives pipeline state-change notifications.
   * If omitted, the pipeline creates its own topic.
   */
  readonly notificationTopicArn?: string;

  /**
   * Email addresses to subscribe to pipeline failure notifications when the
   * pipeline creates its own SNS topic.
   */
  readonly notificationEmails?: string[];

  /**
   * If true, the pipeline builds the AWS Nuke Docker image and pushes it to a
   * private ECR repository in the hub account before running the Compute stack
   * deploy. This sets the PRIVATE_ECR_REPO* env vars used by upstream.
   */
  readonly buildAndPushNukeImage?: boolean;
}
