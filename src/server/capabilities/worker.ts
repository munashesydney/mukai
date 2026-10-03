// Kept as a string so the worker also works inside the bundled Electron main process.
// This is a terminable execution boundary, NOT an OS security sandbox.
export const workerSource = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const pending = new Map();
const controller = new AbortController();
let sequence = 0;
parentPort.on('message', message => {
  if (message.type === 'abort') controller.abort();
  if (message.type === 'reply') {
    const pair = pending.get(message.id);
    if (pair) { pending.delete(message.id); message.error ? pair.reject(new Error(message.error)) : pair.resolve(message.value); }
  }
});
function rpc(action, args) {
  return new Promise((resolve, reject) => {
    const id = ++sequence; pending.set(id, {resolve, reject});
    parentPort.postMessage({type:'rpc', id, action, args});
  });
}
function serializable(value) {
  const text = JSON.stringify(value === undefined ? null : value);
  if (Buffer.byteLength(text) > 262144) throw new Error('Capability result exceeds 256 KB.');
  return JSON.parse(text);
}
// Never forward module stdout/stderr to ordinary application logs.
console.log = console.info = console.warn = console.error = console.debug = () => {};
(async () => {
  const exports = require(workerData.file);
  const definition = exports[workerData.exportName];
  if (!definition || typeof definition !== 'object') throw new Error('Export must be a capability definition object.');
  if (workerData.operation === 'validate') {
    const handler = workerData.kind === 'tool' ? 'execute' : 'handle';
    if (typeof definition[handler] !== 'function') throw new Error('Missing ' + handler + ' handler.');
    const {name, description, inputSchema, requiredEnv = [], timeoutMs = 15000, method, path, auth} = definition;
    parentPort.postMessage({type:'result', value:serializable({name,description,inputSchema,requiredEnv,timeoutMs,method,path,auth,hasJobHandler:typeof definition.processJob === 'function'})});
    return;
  }
  const context = {
    env: workerData.env, workspaceId: workerData.workspaceId, signal: controller.signal,
    enqueue: (provider,eventId,payload) => rpc('enqueue',[provider,eventId,serializable(payload)]),
    wakeBot: message => rpc('wakeBot',[message]),
  };
  const input = workerData.input;
  if (workerData.operation === 'handle') input.rawBody = Buffer.from(input.rawBody);
  const handler = definition[workerData.operation];
  if (typeof handler !== 'function') throw new Error('Missing ' + workerData.operation + ' handler.');
  const value = await handler(input, context);
  parentPort.postMessage({type:'result',value:serializable(value)});
})().catch(error => parentPort.postMessage({type:'error',error:String(error && error.message || error).slice(0,4096)}));
`;
