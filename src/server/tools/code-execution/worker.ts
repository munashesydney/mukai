// The host worker loads QuickJS; generated code runs only inside its WASM heap.
// No Node objects, modules, environment or host references enter the interpreter.
// A string keeps this entry point usable in Electron and the bundled CLI.
export const codeWorkerSource = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { StringDecoder } = require('node:string_decoder');
const { getQuickJS } = require(workerData.enginePath);
let vm, runtime, root, finished = false, sequence = 0;
let remaining = workerData.timeoutMs, deadline = 0, outputBytes = 0, clipped = false;
const pending = new Map();
const errorText = error => String(error && error.message || (typeof error === 'object' ? JSON.stringify(error) : error));
function fail(error) {
  if (finished) return;
  finished = true;
  const timeout = remaining <= 0 || (deadline > 0 && Date.now() >= deadline);
  parentPort.postMessage({type:'error', status:timeout ? 'timeout' : 'error', error: timeout ? 'Script computation timed out. Verify completed actions before retrying.' : String(error && error.message || error).slice(0,4000)});
}
function emit(text) {
  const room = workerData.outputBytes - outputBytes;
  const bytes = Buffer.from((text + '\n').slice(0, room + 1));
  if (bytes.length <= room) {
    parentPort.postMessage({type:'output', text:bytes.toString('utf8')});
    outputBytes += bytes.length;
    return;
  }
  // Keep only complete UTF-8 characters at the capture boundary.
  const prefix = new StringDecoder('utf8').write(bytes.subarray(0, room));
  clipped = true;
  parentPort.postMessage({type:'output', text:prefix, truncated:true});
}
function compute(operation) {
  parentPort.postMessage({type:'busy'});
  const start = Date.now();
  deadline = start + remaining;
  try { return operation(); }
  finally { remaining -= Date.now() - start; }
}
function pump() {
  if (finished) return;
  try {
    compute(() => {
      while (runtime.hasPendingJob()) {
        const result = runtime.executePendingJobs(100);
        if (result.error) {
          const error = vm.dump(result.error);
          result.error.dispose();
          throw new Error(errorText(error));
        }
      }
    });
    const state = vm.getPromiseState(root);
    if (state.type !== 'pending') {
      if (state.type === 'rejected') {
        const error = vm.dump(state.error);
        state.error.dispose();
        throw new Error(errorText(error));
      }
      if (!state.notAPromise) state.value.dispose();
      if (pending.size) throw new Error('Await every tool call before finishing the script. Pending actions may have started; inspect activity before retrying.');
      finished = true;
      parentPort.postMessage({type:'result'});
    } else if (!pending.size) {
      throw new Error('Script is waiting on a promise with no pending tool calls.');
    } else parentPort.postMessage({type:'idle'});
  } catch (error) { fail(error); }
}
parentPort.on('message', message => {
  if (finished || message.type !== 'reply') return;
  const promise = pending.get(message.id);
  if (!promise) return;
  pending.delete(message.id);
  try {
    compute(() => {
      const value = message.error ? vm.newError(message.error) : vm.newString(message.json);
      try { message.error ? promise.reject(value) : promise.resolve(value); }
      finally { value.dispose(); promise.dispose(); }
    });
    pump();
  } catch (error) { fail(error); }
});
(async () => {
  const engine = await getQuickJS();
  runtime = engine.newRuntime();
  runtime.setMemoryLimit(64 * 1024 * 1024);
  runtime.setMaxStackSize(512 * 1024);
  runtime.setInterruptHandler(() => Date.now() >= deadline);
  vm = runtime.newContext();
  vm.newFunction('__print', text => { if (!clipped) emit(vm.getString(text)); }).consume(fn => vm.setProp(vm.global, '__print', fn));
  vm.newFunction('__callTool', (name, args) => {
    if (++sequence > workerData.maxToolCalls) return {error: vm.newError('Code execution tool-call limit reached. Summarize completed work.')};
    const promise = vm.newPromise();
    pending.set(sequence, promise);
    parentPort.postMessage({type:'call', id:sequence, name:vm.getString(name), json:vm.getString(args)});
    return promise.handle;
  }).consume(fn => vm.setProp(vm.global, '__callTool', fn));
  compute(() => {
    vm.unwrapResult(vm.evalCode(
      'globalThis.tools = Object.create(null);' +
      'for (const name of ' + JSON.stringify(workerData.tools) + ') {' +
      'Object.defineProperty(tools, name, {value: async (args) => JSON.parse(await __callTool(name, JSON.stringify(args))), enumerable:true}); }' +
      'Object.freeze(tools);' +
      'globalThis.print = (...args) => __print(args.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" "));' +
      'globalThis.console = Object.freeze({log:print, info:print, warn:print, error:print});'
    )).dispose();
    root = vm.unwrapResult(vm.evalCode('(async () => {\n"use strict";\n' + workerData.code + '\n})()', 'mukai-execute-code.js'));
  });
  pump();
})().catch(fail);
`;
