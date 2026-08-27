import { DeploymentStageConfig } from '../lib/config/environment-config';
import {
  renderStageConfigFile,
  resolveStageEnv,
  shellQuote,
  stageConfigPath,
} from '../lib/config/stage-config-file';
import { stageDiffKey, stageDiffUrl } from '../lib/steps/diff-step';

const stage: DeploymentStageConfig = {
  stageName: 'Dev',
  accounts: {
    orgManagement: { account: '111111111111', region: 'us-west-2' },
    idc: { account: '222222222222', region: 'us-west-2' },
    hub: { account: '333333333333', region: 'us-west-2' },
  },
  envOverrides: {
    NAMESPACE: 'dev',
    PARENT_OU_ID: 'r-abcd',
    AWS_REGIONS: 'us-west-2,us-east-1',
  },
};

describe('stage config file', () => {
  it('resolves the three account IDs alongside the passthrough vars', () => {
    expect(resolveStageEnv(stage)).toEqual({
      NAMESPACE: 'dev',
      PARENT_OU_ID: 'r-abcd',
      AWS_REGIONS: 'us-west-2,us-east-1',
      ORG_MGT_ACCOUNT_ID: '111111111111',
      IDC_ACCOUNT_ID: '222222222222',
      HUB_ACCOUNT_ID: '333333333333',
    });
  });

  it('tolerates a stage with no envOverrides', () => {
    const bare: DeploymentStageConfig = {
      stageName: 'Prod',
      accounts: stage.accounts,
    };
    expect(resolveStageEnv(bare)).toEqual({
      ORG_MGT_ACCOUNT_ID: '111111111111',
      IDC_ACCOUNT_ID: '222222222222',
      HUB_ACCOUNT_ID: '333333333333',
    });
  });

  it('single-quotes every value so it survives `set -a && . file`', () => {
    const rendered = renderStageConfigFile(stage);
    const assignments = rendered
      .split('\n')
      .filter((l) => l && !l.startsWith('#'));
    expect(assignments).toContain("NAMESPACE='dev'");
    expect(assignments).toContain("AWS_REGIONS='us-west-2,us-east-1'");
    for (const line of assignments) {
      expect(line).toMatch(/^[A-Za-z_][A-Za-z0-9_]*='.*'$/);
    }
  });

  it('escapes embedded single quotes', () => {
    // POSIX-safe form: close the quote, emit an escaped quote, reopen.
    expect(shellQuote("a'b")).toBe("'a'\\''b'");
  });

  it('points steps at the stage file inside the mounted synth output', () => {
    expect(stageConfigPath('Dev')).toBe('../isb-config/isb-config-Dev.env');
    expect(stageConfigPath('Staging')).toBe(
      '../isb-config/isb-config-Staging.env',
    );
  });
});

describe('diff publication', () => {
  it('uses a per-stage key so a locked stage is unambiguous', () => {
    expect(stageDiffKey('Dev')).toBe('diffs/Dev/latest.txt');
    expect(stageDiffKey('Prod')).toBe('diffs/Prod/latest.txt');
  });

  it('builds a console URL with the key percent-encoded', () => {
    const url = stageDiffUrl('Dev', 'my-bucket', 'us-west-2');
    expect(url).toBe(
      'https://s3.console.aws.amazon.com/s3/object/my-bucket' +
        '?region=us-west-2&prefix=diffs%2FDev%2Flatest.txt',
    );
  });
});
