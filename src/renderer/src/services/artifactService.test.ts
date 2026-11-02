import { expect, it, vi } from 'vitest';
const http = vi.hoisted(() => ({ api: vi.fn(), apiFetch: vi.fn() }));
vi.mock('./http', () => http);
import { artifactService } from './artifactService';

it('limits preview downloads across galleries, holds slots through body reads, and skips canceled requests', async () => {
  const bodies: (() => void)[] = [];
  const started: number[] = [];
  http.apiFetch.mockImplementation(async () => ({
    headers: new Headers(),
    blob: () => new Promise<Blob>((resolve) => bodies.push(() => resolve(new Blob(['image'])))),
  }));
  const controller = new AbortController();
  const work = Array.from({ length: 10 }, (_, index) =>
    artifactService
      .reference(
        'conversation',
        `image-${index}.png`,
        true,
        index === 5 ? controller.signal : undefined,
        () => {
          started.push(index);
        },
      )
      .catch((error) => error),
  );
  await vi.waitFor(() => expect(bodies).toHaveLength(3));
  expect(http.apiFetch).toHaveBeenCalledTimes(3);
  expect(started).toEqual([0, 1, 2]);
  controller.abort();
  await expect(work[5]).resolves.toBeDefined();
  bodies[0]();
  await vi.waitFor(() => expect(bodies).toHaveLength(4));
  for (let index = 1; index < 9; index++) {
    await vi.waitFor(() => expect(bodies.length).toBeGreaterThan(index));
    bodies[index]();
  }
  await Promise.all(work);
  expect(http.apiFetch).toHaveBeenCalledTimes(9);
  expect(started).not.toContain(5);
  expect(
    http.apiFetch.mock.calls.some(([, input]) => JSON.parse(input.body).href === 'image-5.png'),
  ).toBe(false);
});
