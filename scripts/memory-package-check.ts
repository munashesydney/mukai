import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import assert from 'node:assert/strict';

async function main() {
  const entry = join(
    process.cwd(),
    'artifacts',
    'memory-package',
    'win-unpacked',
    'resources',
    'app.asar.unpacked',
    'node_modules',
    '@huggingface',
    'transformers',
    'dist',
    'transformers.node.cjs',
  );
  assert(existsSync(entry), 'Build the isolated memory desktop package first.');
  const worker = new Worker(
    `
    const {parentPort,workerData}=require('node:worker_threads');
    (async()=>{const {pipeline,env}=await import(workerData.entry);env.cacheDir=workerData.cache;
      const extractor=await pipeline('feature-extraction','Xenova/bge-small-en-v1.5',{device:'cpu',dtype:'q8',local_files_only:true});
      const vector=await extractor('Packaged memory runtime',{pooling:'cls',normalize:true});
      parentPort.postMessage(vector.tolist()[0].length);
    })().catch(error=>{console.error(error);process.exit(1);});
  `,
    {
      eval: true,
      workerData: {
        entry: pathToFileURL(entry).href,
        cache: join(process.cwd(), 'artifacts', 'memory-models'),
      },
    },
  );
  try {
    const dimensions = await new Promise<number>((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
      worker.once('exit', (code) => {
        if (code) reject(new Error('Packaged embedding worker failed.'));
      });
    });
    assert.equal(dimensions, 384);
    console.log('Packaged native embedding runtime passed (384 dimensions).');
  } finally {
    await worker.terminate();
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
