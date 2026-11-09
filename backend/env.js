// MUST be the first import in server.js.
// ES imports are hoisted: if dotenv ran inside server.js body, every other
// module (store.js etc.) would already have evaluated with an EMPTY
// process.env.MONGODB_URI on the self-hosted server. Loading it here, as its
// own module, guarantees the env is populated before anything reads it.
import path from 'path';
import { fileURLToPath } from 'url';
import { config as loadEnv } from 'dotenv';

const dir = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.join(dir, '..', '.env') }); // Map-Panel/.env
loadEnv({ path: path.join(dir, '.env') });       // backend/.env (optional)
