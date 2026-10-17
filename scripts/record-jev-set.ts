import { openDb, getInvoice } from '../src/server/db/db';
import { ensureExampleInvoices, readExampleFixtures } from '../src/server/fixtures';
import { ensureWorkspace } from '../src/server/db/workspace';
import { processBatch } from '../src/server/pipeline';

async function recordJevSet(): Promise<void> {
  if (process.env.EXTRACT_MODE !== 'replay' || process.env.JEV_MODE !== 'record') {
    throw new Error('Use EXTRACT_MODE=replay and JEV_MODE=record.');
  }
  if (!process.env.TYPESAFE_API_KEY?.trim()) {
    throw new Error('TYPESAFE_API_KEY must be available in the private recording environment.');
  }

  const db = openDb(':memory:');
  try {
    const workspaceId = 'jev-recording';
    const fixtures = readExampleFixtures();
    const recordOnly = process.env.RECORD_ONLY;
    const selectedFixtures = recordOnly === undefined
      ? fixtures
      : selectFixtures(fixtures, recordOnly);
    ensureWorkspace(db, workspaceId);
    ensureExampleInvoices(db, workspaceId);

    let decided = 0;
    let failed = false;
    await processBatch({ db }, {
      workspaceId,
      ids: selectedFixtures.map(({ invoiceId }) => invoiceId),
      mode: 'live',
      extractMode: 'replay',
      jevMode: 'record',
      ip: null,
      emit(event) {
        if (event.type === 'decided') decided += 1;
        if (event.type === 'error') failed = true;
      },
    });

    const recorded = selectedFixtures.filter(({ invoiceId }) => {
      const answer = getInvoice(db, workspaceId, invoiceId)?.latestRecord?.jev;
      return answer?.ok === true && answer.recorded === true;
    }).length;
    if (failed || decided !== selectedFixtures.length || recorded !== selectedFixtures.length) {
      throw new Error(`JEV recording incomplete: ${recorded}/${selectedFixtures.length} responses recorded.`);
    }
    console.log(`Recorded genuine JEV responses: ${recorded}/${selectedFixtures.length}. Run the labeled replay test next.`);
  } finally {
    db.close();
  }
}

function selectFixtures(
  fixtures: ReturnType<typeof readExampleFixtures>,
  selection: string,
): typeof fixtures {
  const requestedIds = selection.split(',').map((invoiceId) => invoiceId.trim()).filter(Boolean);
  if (requestedIds.length === 0) {
    throw new Error('RECORD_ONLY must contain a comma-separated list of fixture invoice IDs.');
  }

  const knownIds = new Set(fixtures.map(({ invoiceId }) => invoiceId));
  const unknownIds = [...new Set(requestedIds.filter((invoiceId) => !knownIds.has(invoiceId)))];
  if (unknownIds.length > 0) {
    throw new Error(`RECORD_ONLY contains unknown invoice IDs: ${unknownIds.join(', ')}.`);
  }

  const selectedIds = new Set(requestedIds);
  return fixtures.filter(({ invoiceId }) => selectedIds.has(invoiceId));
}

recordJevSet().catch(() => {
  console.error('JEV recording failed. Check the private environment, provider availability, and recording permissions.');
  process.exitCode = 1;
});
