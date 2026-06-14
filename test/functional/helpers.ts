import * as path from 'path';
import * as fs from 'fs';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '.env.functional') });

const STATE_FILE = path.resolve(__dirname, '.functional-state.json');

export const config = {
  apiUrl: process.env.ISB_API_URL!,
  apiToken: process.env.ISB_API_TOKEN!,
  hubRegion: process.env.ISB_HUB_REGION ?? 'us-west-2',
  namespace: process.env.ISB_NAMESPACE ?? 'myisb',
};

export async function isbApi(
  method: string,
  apiPath: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; data: any }> {
  const response = await fetch(`${config.apiUrl}${apiPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.apiToken}`,
      'Content-Type': 'application/json',
      Origin: config.apiUrl.replace('/api', ''),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => null);
  return { status: response.status, data };
}

export function pollUntil(
  fn: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 10_000,
): Promise<void> {
  return new Promise(async (resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        if (await fn()) return resolve();
      } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    reject(new Error(`Timed out after ${timeoutMs}ms`));
  });
}

export function saveState(state: Record<string, string>) {
  const existing = loadState();
  fs.writeFileSync(STATE_FILE, JSON.stringify({ ...existing, ...state }, null, 2));
}

export function loadState(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

export function clearState() {
  if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
}
