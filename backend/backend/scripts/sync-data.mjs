// Two-way sync between this machine's data/ folder and MongoDB, on demand.
//   cd backend && npm run sync
// - missing on one side  -> copied to the other
// - different on both    -> the newer one wins
// - deleted in the app   -> deleted from data/
// (The running server does the same automatically every 30 seconds.)
import '../env.js';
import { syncBothWays, diagnose } from '../services/store.js';

if (!process.env.MONGODB_URI) { console.error('MONGODB_URI is not set in the project-root .env'); process.exit(1); }
try {
  const r = await syncBothWays();
  console.log(`Done: ${r.pushed} sent to Mongo, ${r.pulled} brought into data/, ${r.deleted} deleted from data/.`);
  const d = await diagnose();
  console.log('Mongo:', d.mongoConnection, '| diagrams:', d.diagramsResolved, '| pdfs:', d.pdfsResolved, '| files stored:', d.storedFiles);
  process.exit(0);
} catch (e) {
  console.error('FAILED:', e.message);
  if (/auth/i.test(e.message)) console.error('-> Wrong MongoDB username/password in MONGODB_URI.');
  process.exit(1);
}
