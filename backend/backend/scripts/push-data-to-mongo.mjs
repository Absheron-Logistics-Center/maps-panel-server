// One-time (or any time) upload of this machine's data/ folder into MongoDB.
//   cd backend
//   node scripts/push-data-to-mongo.mjs            -> adds only what Mongo doesn't have
//   node scripts/push-data-to-mongo.mjs --replace  -> Mongo gets EXACTLY this folder's data
// Needs MONGODB_URI in Map-Panel/.env (loaded automatically).
import '../env.js';
import { pushLocalToMongo, diagnose } from '../services/store.js';

if (!process.env.MONGODB_URI) {
  console.error('MONGODB_URI is not set. Put it in the project-root .env file first.');
  process.exit(1);
}
const overwrite = process.argv.includes('--replace');
try {
  console.log(overwrite ? 'Replacing Mongo data with this folder...' : 'Adding missing data to Mongo...');
  const r = await pushLocalToMongo({ overwrite });
  console.log(`Done: ${r.json} documents and ${r.binary} files uploaded.`);
  const d = await diagnose();
  console.log('Check:', JSON.stringify({
    mongoConnection: d.mongoConnection, diagrams: d.diagramsResolved,
    pdfs: d.pdfsResolved, templates: d.templatesResolved, storedFiles: d.storedFiles, writeProbe: d.writeProbe
  }, null, 2));
  process.exit(0);
} catch (e) {
  console.error('FAILED:', e.message);
  if (/auth/i.test(e.message)) console.error('-> Wrong MongoDB username/password in MONGODB_URI. Reset the password in Atlas > Database Access.');
  process.exit(1);
}
