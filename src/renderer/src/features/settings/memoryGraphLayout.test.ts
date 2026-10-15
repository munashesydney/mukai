import { describe, expect, it } from 'vitest';
import type { MemoryGraph, MemoryFact } from '../../../../shared/memory';
import { layoutMemoryGraph, memoryEdgePath } from './memoryGraphLayout';

const fact = (
  subjectId: string,
  objectId: string,
  id = `${subjectId}-${objectId}`,
): MemoryFact => ({
  id,
  subjectId,
  objectId,
  subject: subjectId,
  object: objectId,
  workspaceId: 'workspace',
  ownerId: null,
  relation: 'knows',
  text: `${subjectId} knows ${objectId}`,
  validFrom: '2026-10-13',
  validTo: null,
  createdAt: '2026-10-13',
  supersededBy: null,
  state: 'confirmed',
  sources: [],
});
const graph = (edges: MemoryFact[]): MemoryGraph => ({
  edges,
  truncated: false,
  nodes: [...new Set(edges.flatMap((edge) => [edge.subjectId, edge.objectId]))].map((id) => ({
    id,
    name: id,
    type: 'entity',
    ownerId: null,
  })),
});

function expectSeparated(result: ReturnType<typeof layoutMemoryGraph>) {
  for (const [index, node] of result.nodes.entries()) {
    expect(node.x).toBeGreaterThanOrEqual(0);
    expect(node.y - node.radius).toBeGreaterThanOrEqual(0);
    expect(node.x + node.radius).toBeLessThan(result.width);
    expect(node.y + node.radius + 17).toBeLessThan(result.height);
    for (const other of result.nodes.slice(index + 1)) {
      expect(Math.abs(node.x - other.x) >= 140 || Math.abs(node.y - other.y) >= 59).toBe(true);
    }
  }
}

describe('Organic memory graph layout', () => {
  it('separates a dense hub, branches and disconnected clusters without losing cross-links', () => {
    const input = graph([
      ...Array.from({ length: 20 }, (_, index) => fact('hub', `leaf-${index}`)),
      fact('leaf-0', 'child'),
      fact('child', 'hub'),
      fact('separate', 'neighbor'),
      fact('separate', 'third'),
    ]);
    const result = layoutMemoryGraph(input);
    expect(result.nodes).toHaveLength(input.nodes.length);
    expect(result.edges).toEqual(input.edges);
    expect(result.positions.get('hub')!.radius).toBeGreaterThan(
      result.positions.get('leaf-0')!.radius,
    );
    expectSeparated(result);
    expect(layoutMemoryGraph(input)).toEqual(result);
  });

  it('roots the selected neighborhood at the focused entity and excludes unrelated facts', () => {
    const result = layoutMemoryGraph(graph([fact('a', 'b'), fact('b', 'c'), fact('c', 'd')]), 'b');
    expect(result.nodes.map((node) => node.id).sort()).toEqual(['a', 'b', 'c']);
    expect(result.positions.get('b')!.radius).toBeGreaterThan(result.positions.get('a')!.radius);
    expect(result.edges).toHaveLength(2);
    expectSeparated(result);
  });

  it('bounds large graphs and safely handles missing endpoints and empty graphs', () => {
    const input = graph(Array.from({ length: 40 }, (_, index) => fact('hub', `leaf-${index}`)));
    input.edges.unshift(fact('missing', 'hub'));
    const result = layoutMemoryGraph(input);
    expect(result.edges).toHaveLength(35);
    expect(result.truncated).toBe(true);
    expect(result.edges.some((edge) => edge.subjectId === 'missing')).toBe(false);
    expectSeparated(result);
    expect(layoutMemoryGraph(graph([])).nodes).toEqual([]);
  });

  it('draws cycles, self-links and parallel links with finite, distinct paths', () => {
    const input = graph([fact('a', 'b'), fact('b', 'c'), fact('c', 'a'), fact('a', 'a')]);
    const result = layoutMemoryGraph(input);
    expectSeparated(result);
    for (const edge of result.edges) {
      const source = result.positions.get(edge.subjectId)!;
      const target = result.positions.get(edge.objectId)!;
      const path = memoryEdgePath(source, target);
      expect(path).not.toMatch(/NaN|undefined|Infinity/);
      expect(memoryEdgePath(source, target, 1)).not.toBe(path);
    }
  });
});
