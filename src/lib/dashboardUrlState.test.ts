import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDashboardSearch, serializeDashboardSearch } from './dashboardUrlState';

test('dashboard URL state accepts supported views and bounds identifiers', () => {
  const result = parseDashboardSearch('?view=chat&task=task-123&session=session-456');
  assert.deepEqual(result, { view: 'chat', taskId: 'task-123', sessionId: 'session-456' });
  assert.deepEqual(parseDashboardSearch('?view=unknown&task=&session='), {});
});

test('dashboard URL serialization preserves unrelated parameters and supports clearing', () => {
  const search = serializeDashboardSearch({ view: 'workflows' }, '?debug=1&view=chat&task=old&session=old-session');
  assert.equal(search, '?debug=1&view=workflows&task=old&session=old-session');
  const cleared = serializeDashboardSearch({ taskId: undefined, sessionId: undefined }, search);
  assert.equal(cleared, '?debug=1&view=workflows');
});
