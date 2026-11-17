import { overlaps } from './history-time';

export type HistoricalRelation = {
  id: string; from: string; to: string; sourceId: string;
  start: number | null; end: number | null;
  adopted: boolean; kind: 'historical' | 'fictional';
};
export function associationReport(people: string[], relations: HistoricalRelation[], from: number, to: number, validSources: Set<string>) {
  const selected = [...new Set(people)];
  const edges = relations.filter(edge => edge.kind === 'historical' && edge.adopted && validSources.has(edge.sourceId) && overlaps(edge.start, edge.end, from, to));
  const adjacency = new Map<string, Array<{ person: string; edge: string }>>();
  for (const edge of edges) {
    for (const [a, b] of [[edge.from, edge.to], [edge.to, edge.from]]) {
      const neighbors = adjacency.get(a) ?? [];
      neighbors.push({ person: b, edge: edge.id }); adjacency.set(a, neighbors);
    }
  }
  function paths(start: string, target: string) {
    const queue = [{ person: start, people: [start], edges: [] as string[] }];
    const distance = new Map([[start, 0]]);
    const result: Array<{ people: string[]; edges: string[] }> = [];
    let shortest = Infinity;
    let visited = 0;
    while (queue.length && result.length < 3 && visited < 10000) {
      const current = queue.shift()!; visited++;
      if (current.edges.length > shortest) break;
      if (current.person === target) { shortest = current.edges.length; result.push(current); continue; }
      for (const neighbor of adjacency.get(current.person) ?? []) {
        const nextDistance = current.edges.length + 1;
        if (current.people.includes(neighbor.person) || nextDistance > (distance.get(neighbor.person) ?? Infinity)) continue;
        distance.set(neighbor.person, nextDistance);
        queue.push({ person: neighbor.person, people: [...current.people, neighbor.person], edges: [...current.edges, neighbor.edge] });
      }
    }
    return { paths: result, truncated: visited >= 10000 };
  }
  const pairs = selected.flatMap((person, index) => selected.slice(index + 1).map(other => ({ from: person, to: other, ...paths(person, other) })));
  const remaining = new Set(selected);
  const groups: string[][] = [];
  while (remaining.size) {
    const start = remaining.values().next().value!;
    const seen = new Set([start]); const queue = [start];
    while (queue.length) for (const neighbor of adjacency.get(queue.shift()!) ?? []) {
      if (!seen.has(neighbor.person)) { seen.add(neighbor.person); queue.push(neighbor.person); }
    }
    const group = selected.filter(person => seen.has(person));
    group.forEach(person => remaining.delete(person)); groups.push(group);
  }
  return { edges, groups, pairs, isolated: groups.filter(group => group.length === 1).flat(), note: '仅依据当前有效且已采用的史实关系；未找到关联不表示不存在关联。' };
}
