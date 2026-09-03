describe("pipeline config v1.3.0 inputs", () => {
  const originalEnv = process.env;

  function baseEnv(): NodeJS.ProcessEnv {
    return {
      ...originalEnv,
      TOOLING_ACCOUNT: "000000000000",
      TOOLING_REGION: "us-east-1",
      UPSTREAM_CODESTAR_CONNECTION_ARN:
        "arn:aws:codeconnections:us-east-1:000000000000:connection/upstream",
      PIPELINE_CODESTAR_CONNECTION_ARN:
        "arn:aws:codeconnections:us-east-1:000000000000:connection/pipeline",
      PIPELINE_GITHUB_OWNER: "example",
      PIPELINE_GITHUB_REPO: "isb-pipeline",
      DEV_ORG_MGT_ACCOUNT: "111111111111",
      DEV_IDC_ACCOUNT: "222222222222",
      DEV_HUB_ACCOUNT: "333333333333",
      DEV_SAML_METADATA_URL:
        "https://portal.sso.us-east-1.amazonaws.com/saml/metadata/example",
      DEV_AWS_ACCESS_PORTAL_URL: "https://d-example.awsapps.com/start",
      DEV_ADDITIONAL_ALLOWED_SERVICES: "sts:*,support:*",
      DEV_ADDITIONAL_PRINCIPAL_EXCEPTIONS:
        "arn:aws:iam::*:role/CustomGovernanceRole*",
      DEV_BEDROCK_INFERENCE_PROFILE_PATTERNS:
        "arn:aws:bedrock:*:*:inference-profile/us.*",
      DEV_ALLOW_LISTED_IP_RANGES: "10.0.0.0/8",
    };
  }

  beforeEach(() => {
    jest.resetModules();
    process.env = baseEnv();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("forwards required auth and SCP customization values", () => {
    const { loadPipelineConfig } = require("../lib/config/pipeline-config");
    const config = loadPipelineConfig();
    expect(config.stages[0].envOverrides).toEqual(
      expect.objectContaining({
        SAML_METADATA_URL:
          "https://portal.sso.us-east-1.amazonaws.com/saml/metadata/example",
        AWS_ACCESS_PORTAL_URL: "https://d-example.awsapps.com/start",
        ADDITIONAL_ALLOWED_SERVICES: "sts:*,support:*",
        ADDITIONAL_PRINCIPAL_EXCEPTIONS:
          "arn:aws:iam::*:role/CustomGovernanceRole*",
        BEDROCK_INFERENCE_PROFILE_PATTERNS:
          "arn:aws:bedrock:*:*:inference-profile/us.*",
        ALLOW_LISTED_IP_RANGES: "10.0.0.0/8",
      }),
    );
  });

  it("fails before deployment when the required SAML metadata URL is missing", () => {
    process.env.DEV_SAML_METADATA_URL = "   ";
    expect(() => require("../lib/config/pipeline-config")).toThrow(
      "Required environment variable DEV_SAML_METADATA_URL is missing",
    );
  });
});
