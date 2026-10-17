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
    ensureWorkspace(db, workspaceId);
    ensureExampleInvoices(db, workspaceId);

    let decided = 0;
    let failed = false;
    await processBatch({ db }, {
      workspaceId,
      ids: fixtures.map(({ invoiceId }) => invoiceId),
      mode: 'live',
      extractMode: 'replay',
      jevMode: 'record',
      ip: null,
      emit(event) {
        if (event.type === 'decided') decided += 1;
        if (event.type === 'error') failed = true;
      },
    });

    const recorded = fixtures.filter(({ invoiceId }) => {
      const answer = getInvoice(db, workspaceId, invoiceId)?.latestRecord?.jev;
      return answer?.ok === true && answer.recorded === true;
    }).length;
    if (failed || decided !== fixtures.length || recorded !== fixtures.length) {
      throw new Error(`JEV recording incomplete: ${recorded}/${fixtures.length} responses recorded.`);
    }
    console.log(`Recorded genuine JEV responses: ${recorded}/${fixtures.length}. Run the labeled replay test next.`);
  } finally {
    db.close();
  }
}

recordJevSet().catch(() => {
  console.error('JEV recording failed. Check the private environment, provider availability, and recording permissions.');
  process.exitCode = 1;
});
