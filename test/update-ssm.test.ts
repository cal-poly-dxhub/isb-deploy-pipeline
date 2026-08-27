import * as dotenv from 'dotenv';

import {
  DEFAULT_REGION,
  parseEnvFile,
  resolveRegion,
  serialiseConfig,
} from '../scripts/update-ssm';

describe('update-ssm config publishing', () => {
  it('parses .env with the same library the synth-time loader uses', () => {
    // Regression: the previous shell implementation hand-rolled this and
    // disagreed with dotenv on an unquoted '#', so a value was published to SSM
    // as "bar#baz" but read back at synth as "bar".
    const contents = [
      'A=bar#baz',
      'B=bar # trailing comment',
      'C="quoted # hash"',
      'export D=exported',
      '# a comment',
      '',
      'E=',
    ].join('\n');

    const parsed = parseEnvFile(contents);
    expect(parsed).toEqual(dotenv.parse(contents));
    expect(parsed.A).toBe('bar');
    expect(parsed.B).toBe('bar');
    expect(parsed.C).toBe('quoted # hash');
    expect(parsed.D).toBe('exported');
    expect(parsed.E).toBe('');
  });

  it('serialises deterministically so unchanged input is a no-op write', () => {
    const a = serialiseConfig({ B: '2', A: '1' });
    const b = serialiseConfig({ A: '1', B: '2' });
    expect(a).toBe(b);
    expect(a).toBe('{"A":"1","B":"2"}');
    // Compact: no whitespace that would make a byte comparison spuriously fail.
    expect(a).not.toMatch(/\s/);
  });

  it('resolves region as AWS_REGION, then TOOLING_REGION, then the default', () => {
    expect(
      resolveRegion({ TOOLING_REGION: 'us-west-2' }, { AWS_REGION: 'eu-west-1' }),
    ).toBe('eu-west-1');
    expect(resolveRegion({ TOOLING_REGION: 'us-west-2' }, {})).toBe('us-west-2');
    expect(resolveRegion({}, {})).toBe(DEFAULT_REGION);
    // Blank values must not win over the next source.
    expect(
      resolveRegion({ TOOLING_REGION: 'us-west-2' }, { AWS_REGION: '   ' }),
    ).toBe('us-west-2');
  });
});
