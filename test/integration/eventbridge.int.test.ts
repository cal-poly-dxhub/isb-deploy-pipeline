/**
 * EventBridge tests.
 *
 * The solution uses EventBridge for routing internal events (lease state
 * transitions, budget breaches, account lifecycle events). We:
 *
 *   1. Verify the named event bus exists.
 *   2. Verify there is at least one ENABLED rule on it.
 *   3. Verify every enabled rule has at least one target.
 *
 * A rule with zero targets is almost always a regression (the event ends up
 * in the void). We catch it before users notice.
 */
import {
  EventBridgeClient,
  ListEventBusesCommand,
  ListRuleNamesByTargetCommand,
  ListRulesCommand,
  ListTargetsByRuleCommand,
} from '@aws-sdk/client-eventbridge';

import { loadIntegrationEnv } from './support/test-env';

jest.setTimeout(120_000);

const env = loadIntegrationEnv();

describe('EventBridge', () => {
  const client = new EventBridgeClient({ region: env.hubRegion });

  it('has a custom event bus dedicated to InnovationSandbox', async () => {
    const response = await client.send(new ListEventBusesCommand({}));
    const bus = response.EventBuses?.find((b) =>
      (b.Name ?? '').toLowerCase().includes('innovationsandbox'),
    );
    // The default bus is always present; we want a custom bus named for the
    // solution. If upstream stops creating one, this catches the change.
    expect(bus).toBeDefined();
  });

  it('every enabled rule has at least one target', async () => {
    // Enumerate the InnovationSandbox bus first; fall back to default.
    const buses = await client.send(new ListEventBusesCommand({}));
    const isbBus = buses.EventBuses?.find((b) =>
      (b.Name ?? '').toLowerCase().includes('innovationsandbox'),
    );
    const eventBusName = isbBus?.Name ?? 'default';

    const rules = await client.send(
      new ListRulesCommand({ EventBusName: eventBusName }),
    );
    const enabled = (rules.Rules ?? []).filter((r) => r.State === 'ENABLED');
    expect(enabled.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const rule of enabled) {
      if (!rule.Name) continue;
      const targets = await client.send(
        new ListTargetsByRuleCommand({
          EventBusName: eventBusName,
          Rule: rule.Name,
        }),
      );
      if ((targets.Targets ?? []).length === 0) {
        offenders.push(rule.Name);
      }
    }
    expect(offenders).toEqual([]);
  });
});

// Suppress unused-import lint complaints for ListRuleNamesByTargetCommand
// (kept here for future tests that wire it up).
void ListRuleNamesByTargetCommand;
