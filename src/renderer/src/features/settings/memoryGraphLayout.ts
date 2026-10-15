import type { MemoryGraph } from '../../../../shared/memory';

export const memoryGraphColors = ['#3f9dcc', '#d99b35', '#a77ac7', '#45a989', '#db7865'];

export function layoutMemoryGraph(graph: MemoryGraph, focus: string | null = null) {
  const knownIds = new Set(graph.nodes.map((node) => node.id));
  const candidates = graph.edges.filter(
    (edge) =>
      knownIds.has(edge.subjectId) &&
      knownIds.has(edge.objectId) &&
      (!focus || edge.subjectId === focus || edge.objectId === focus),
  );
  const limited = candidates.slice(0, 35);
  const ids = new Set(limited.flatMap((edge) => [edge.subjectId, edge.objectId]));
  const nodes = graph.nodes.filter((node) => ids.has(node.id)).slice(0, 36);
  const shownIds = new Set(nodes.map((node) => node.id));
  const edges = limited.filter(
    (edge) => shownIds.has(edge.subjectId) && shownIds.has(edge.objectId),
  );
  const neighbors = new Map(nodes.map((node) => [node.id, new Set<string>()]));
  for (const edge of edges) {
    if (edge.subjectId === edge.objectId) continue;
    neighbors.get(edge.subjectId)!.add(edge.objectId);
    neighbors.get(edge.objectId)!.add(edge.subjectId);
  }
  const ranked = [...nodes].sort(
    (a, b) =>
      Number(b.id === focus) - Number(a.id === focus) ||
      neighbors.get(b.id)!.size - neighbors.get(a.id)!.size ||
      a.id.localeCompare(b.id),
  );
  const visited = new Set<string>();
  const components: string[][] = [];
  const groups = new Map<string, number>();
  let colorIndex = 0;
  for (const root of ranked) {
    if (visited.has(root.id)) continue;
    const queue = [root.id];
    visited.add(root.id);
    groups.set(root.id, colorIndex++);
    for (let index = 0; index < queue.length; index++) {
      const id = queue[index];
      for (const neighbor of [...neighbors.get(id)!].sort()) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        groups.set(neighbor, id === root.id ? colorIndex++ : groups.get(id)!);
        queue.push(neighbor);
      }
    }
    components.push(queue);
  }
  const coordinates = new Map<string, { x: number; y: number }>();
  const boxes: { ids: string[]; width: number; height: number }[] = [];
  for (const component of components) {
    const points = component.map((id, index) => ({
      id,
      x: Math.cos(index * 2.39996) * Math.sqrt(index) * 65,
      y: Math.sin(index * 2.39996) * Math.sqrt(index) * 65,
    }));
    const byId = new Map(points.map((point) => [point.id, point]));
    const links = edges.filter((edge) => byId.has(edge.subjectId) && byId.has(edge.objectId));
    // Deterministic spring layout: connections pull entities together, while
    // repulsion and label clearance let branches spread naturally.
    for (let step = 0; step < 400; step++) {
      const forces = points.map((point) => ({ x: -point.x * 0.008, y: -point.y * 0.008 }));
      for (let a = 0; a < points.length; a++) {
        for (let b = a + 1; b < points.length; b++) {
          const dx = points[a].x - points[b].x;
          const dy = points[a].y - points[b].y;
          const distance = Math.max(1, Math.hypot(dx, dy));
          const force = 2400 / (distance * distance);
          forces[a].x += (dx / distance) * force;
          forces[a].y += (dy / distance) * force;
          forces[b].x -= (dx / distance) * force;
          forces[b].y -= (dy / distance) * force;
          if (Math.abs(dx) < 140 && Math.abs(dy) < 62) {
            const push = (62 - Math.abs(dy)) * 0.12 * (dy < 0 ? -1 : 1);
            forces[a].y += push;
            forces[b].y -= push;
          }
        }
      }
      for (const link of links) {
        const source = byId.get(link.subjectId)!;
        const target = byId.get(link.objectId)!;
        if (source === target) continue;
        const dx = target.x - source.x;
        const dy = target.y - source.y;
        const distance = Math.max(1, Math.hypot(dx, dy));
        const force = (distance - 135) * 0.035;
        const a = component.indexOf(source.id),
          b = component.indexOf(target.id);
        forces[a].x += (dx / distance) * force;
        forces[a].y += (dy / distance) * force;
        forces[b].x -= (dx / distance) * force;
        forces[b].y -= (dy / distance) * force;
      }
      const cooling = 1 - step / 450;
      points.forEach((point, index) => {
        point.x += Math.max(-10, Math.min(10, forces[index].x)) * cooling;
        point.y += Math.max(-10, Math.min(10, forces[index].y)) * cooling;
      });
    }
    // Reserve actual label space after settling, including long names.
    for (let step = 0; step < 600; step++) {
      for (let a = 0; a < points.length; a++) {
        for (let b = a + 1; b < points.length; b++) {
          const dx = points[a].x - points[b].x,
            dy = points[a].y - points[b].y;
          if (Math.abs(dx) < 145 && Math.abs(dy) < 61) {
            if (145 - Math.abs(dx) < 61 - Math.abs(dy)) {
              const shift = (145 - Math.abs(dx)) / 2 + 0.1;
              points[a].x += dx < 0 ? -shift : shift;
              points[b].x -= dx < 0 ? -shift : shift;
            } else {
              const shift = (61 - Math.abs(dy)) / 2 + 0.1;
              points[a].y += dy < 0 ? -shift : shift;
              points[b].y -= dy < 0 ? -shift : shift;
            }
          }
        }
      }
    }
    const minX = Math.min(...points.map((point) => point.x)) - 85;
    const minY = Math.min(...points.map((point) => point.y)) - 40;
    const width = Math.max(...points.map((point) => point.x)) - minX + 85;
    const height = Math.max(...points.map((point) => point.y)) - minY + 60;
    points.forEach((point) => coordinates.set(point.id, { x: point.x - minX, y: point.y - minY }));
    boxes.push({ ids: component, width, height });
  }
  const columns = Array.from({ length: boxes.length > 1 ? 2 : 1 }, () => ({ width: 0, height: 0 }));
  const placements = boxes.map((box) => {
    const column = columns.length === 1 || columns[0].height <= columns[1].height ? 0 : 1;
    const y = columns[column].height;
    columns[column].width = Math.max(columns[column].width, box.width);
    columns[column].height += box.height + 40;
    return { box, column, y };
  });
  for (const { box, column, y } of placements) {
    for (const id of box.ids) {
      const point = coordinates.get(id)!;
      point.x += 24 + (column === 0 ? 0 : columns[0].width + 40);
      point.y += 24 + y;
    }
  }
  const width = columns.reduce((sum, column) => sum + column.width, 48) + (columns.length - 1) * 40;
  const height = Math.max(...columns.map((column) => column.height)) + 8;
  const positioned = nodes.map((node) => ({
    ...node,
    ...coordinates.get(node.id)!,
    radius: 5 + Math.min(10, Math.sqrt(neighbors.get(node.id)!.size) * 3),
    color: memoryGraphColors[groups.get(node.id)! % memoryGraphColors.length],
  }));
  return {
    nodes: positioned,
    edges,
    positions: new Map(positioned.map((node) => [node.id, node])),
    width: Math.max(660, width),
    height: Math.max(400, height),
    truncated: graph.truncated || candidates.length > edges.length,
  };
}

export function memoryEdgePath(
  source: { x: number; y: number; radius: number },
  target: { x: number; y: number; radius: number },
  offset = 0,
) {
  if (source.x === target.x && source.y === target.y) {
    return `M ${source.x - source.radius} ${source.y} C ${source.x - 50 - offset * 10} ${source.y - 60}, ${source.x + 50 + offset * 10} ${source.y - 60}, ${source.x + source.radius} ${source.y}`;
  }
  const dx = target.x - source.x,
    dy = target.y - source.y;
  const distance = Math.max(1, Math.hypot(dx, dy));
  const startX = source.x + (dx / distance) * source.radius,
    startY = source.y + (dy / distance) * source.radius;
  const endX = target.x - (dx / distance) * (target.radius + 3),
    endY = target.y - (dy / distance) * (target.radius + 3);
  const bend = offset * 18;
  return `M ${startX} ${startY} Q ${(startX + endX) / 2 - (dy / distance) * bend} ${(startY + endY) / 2 + (dx / distance) * bend}, ${endX} ${endY}`;
}
