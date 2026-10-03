import assert from 'node:assert/strict';
import { join } from 'node:path';
import { BgeEmbedder } from '../mukai_memory/src';

async function main() {
  const cacheDir = join(process.cwd(), 'artifacts', 'memory-models');
  const embedder = new BgeEmbedder(cacheDir);
  try {
    console.log('Loading quantized BGE on CPU (downloads once if missing)…');
    await embedder.initialize(true);
    const vectors = await embedder.embed(
      [
        'User prefers espresso every morning.',
        'Mukai stores data in SQLite.',
        'Alex is a software engineer.',
      ],
      'document',
    );
    const [query] = await embedder.embed(['What coffee does the user like?'], 'query');
    assert.equal(query.length, 384);
    assert(vectors.every((vector) => vector.length === 384 && vector.every(Number.isFinite)));
    const scores = vectors.map((vector) =>
      vector.reduce((sum, value, index) => sum + value * query[index], 0),
    );
    assert(scores[0] > scores[1] && scores[0] > scores[2]);
    assert(Math.abs(query.reduce((sum, value) => sum + value * value, 0) - 1) < 0.001);
    console.log(JSON.stringify({ dimensions: query.length, scores, cacheDir }));
  } finally {
    await embedder.dispose();
  }
  const offline = new BgeEmbedder(cacheDir);
  try {
    await offline.initialize(false);
    assert.equal((await offline.embed(['Cached offline inference'], 'document'))[0].length, 384);
    console.log('Cached offline CPU inference passed.');
  } finally {
    await offline.dispose();
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
