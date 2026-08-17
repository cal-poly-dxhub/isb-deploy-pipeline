import { execFileSync } from 'child_process';
import * as path from 'path';

/**
 * The unblocker's decision logic lives in an ESM module (.mjs) because the
 * Lambda asset is shipped as-is and `*.js` is gitignored in this repo. The Jest
 * projects are CommonJS, so the assertions run in a child `node` process.
 */
describe('approval unblocker decision logic', () => {
  it('passes every scenario in check-approval-select.mjs', () => {
    const script = path.join(
      __dirname,
      'support',
      'check-approval-select.mjs',
    );
    const output = execFileSync(process.execPath, [script], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(output).toContain('all assertions passed');
  });
});
