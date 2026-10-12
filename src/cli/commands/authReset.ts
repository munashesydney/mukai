import { acquireDataLock } from '../../server/config';
import { Database } from '../../server/db/database';

/** Recovery requires local filesystem access and a stopped backend. */
export function authReset(dataDir: string) {
  const release = acquireDataLock(dataDir);
  let store: Database | undefined;
  try {
    store = new Database(dataDir);
    store.transaction(() => {
      store!.run('DELETE FROM web_sessions');
      store!.run('DELETE FROM web_owner');
    });
    console.log(
      'Owner login and browser sessions reset. Start mukai serve to create a new login. Your workspace data is preserved.',
    );
    return 0;
  } finally {
    store?.db.close();
    release();
  }
}
