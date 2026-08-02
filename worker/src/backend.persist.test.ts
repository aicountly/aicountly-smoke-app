import assert from 'node:assert/strict';
import test from 'node:test';
import { AxiosError } from 'axios';
import { persistRows } from './backend.js';

test('persistRows continues after a row failure and reports failures', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const result = await persistRows('/worker/ux-issues', [
    { title: 'ok-1' },
    { title: 'boom' },
    { title: 'ok-2' },
  ], async (_url, data) => {
    calls.push(data);
    if (data.title === 'boom') {
      const err = new AxiosError('Request failed with status code 500');
      err.response = {
        status: 500,
        data: { message: 'column human_summary does not exist' },
        statusText: 'Internal Server Error',
        headers: {},
        config: {} as never,
      };
      throw err;
    }
  });

  assert.equal(calls.length, 3);
  assert.equal(result.attempted, 3);
  assert.equal(result.saved, 2);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0]?.index, 1);
  assert.equal(result.failures[0]?.status, 500);
  assert.match(result.failures[0]?.message ?? '', /human_summary/);
});

test('persistRows reports empty failures when every row saves', async () => {
  const result = await persistRows('/worker/feature-gaps', [{ a: 1 }, { a: 2 }], async () => undefined);
  assert.deepEqual(result, { attempted: 2, saved: 2, failures: [] });
});
