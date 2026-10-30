import { runningServer } from '../serverState';

export async function status(dataDir: string) {
  const state = await runningServer(dataDir);
  if (!state) {
    console.log(`No Mukai backend is running for ${dataDir}.`);
    return 1;
  }
  console.log(
    `Mukai ${state.version} is running (PID ${state.pid}).\nLocal address: ${state.url}\nConnect: ${state.connectionUrl}\nData: ${dataDir}`,
  );
  return 0;
}
