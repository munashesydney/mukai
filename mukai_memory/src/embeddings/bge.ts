import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import type { Embedder } from '../types';

// CPU inference runs outside the API/Electron main event loop. No executable path or
// user-controlled code enters this worker; model and pooling are fixed here.
export class BgeEmbedder implements Embedder {
  readonly model = 'Xenova/bge-small-en-v1.5:q8:cls:normalized:v1';
  private worker?: Worker;
  private sequence = 0;
  private pending = new Map<
    number,
    { resolve: (vectors: number[][]) => void; reject: (error: Error) => void }
  >();
  ready = false;
  constructor(private cacheDir: string) {}
  async initialize(download = false) {
    await this.request([], download);
    this.ready = true;
  }
  async embed(texts: string[], kind: 'query' | 'document') {
    if (!this.ready) throw new Error('Local embeddings are not initialized.');
    return this.request(
      texts.map((text) =>
        kind === 'query'
          ? `Represent this sentence for searching relevant passages: ${text}`
          : text,
      ),
      false,
    );
  }
  private request(texts: string[], download: boolean) {
    if (!this.worker) {
      // Resolve from the installed host package, not the model cache directory.
      const resolved = createRequire(
        typeof __filename === 'string' ? __filename : join(process.cwd(), 'package.json'),
      ).resolve('@huggingface/transformers');
      // A plain Node worker imports the physical runtime shipped outside Electron's archive.
      const entry = resolved.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
      this.worker = new Worker(
        `
        const { parentPort, workerData } = require('node:worker_threads');
        let extractor;
        let queue = Promise.resolve();
        parentPort.on('message', message => {
          queue = queue.catch(() => {}).then(async () => {
            try {
              if (!extractor) {
                const { pipeline, env } = await import(workerData.entry);
                env.cacheDir = workerData.cacheDir;
                extractor = await pipeline('feature-extraction','Xenova/bge-small-en-v1.5',{
                  dtype:'q8', device:'cpu', local_files_only: !message.download,
                  session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 }
                });
              }
              const vectors = message.texts.length ? (await extractor(message.texts,{pooling:'cls',normalize:true,truncation:true,max_length:512})).tolist() : [];
              parentPort.postMessage({id:message.id,vectors});
            } catch { parentPort.postMessage({id:message.id,error:'Local embedding model unavailable. Download it in Memory settings or check the cached files.'}); }
          });
        });
      `,
        { eval: true, workerData: { entry: pathToFileURL(entry).href, cacheDir: this.cacheDir } },
      );
      this.worker.on('message', (message: { id: number; vectors: number[][]; error?: string }) => {
        const task = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) task?.reject(new Error(message.error));
        else task?.resolve(message.vectors);
      });
      this.worker.on('error', () => this.rejectPending());
      this.worker.on('exit', () => {
        this.worker = undefined;
        this.ready = false;
        this.rejectPending();
      });
    }
    const id = ++this.sequence;
    return new Promise<number[][]>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker!.postMessage({ id, texts, download });
    });
  }
  private rejectPending() {
    for (const task of this.pending.values())
      task.reject(new Error('Local embedding worker stopped.'));
    this.pending.clear();
  }
  async dispose() {
    this.ready = false;
    await this.worker?.terminate();
    this.worker = undefined;
    this.rejectPending();
  }
}
