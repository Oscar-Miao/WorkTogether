import { DomainError } from './index.js';

/** 检查引用与环路；不依赖数据库，因此计划提交与在线关系变更可共用。 */
export function validateDependencyGraph(nodes: { name: string; dependencies: string[] }[]): void {
  const graph = new Map(nodes.map((n) => [n.name, n.dependencies]));
  if (graph.size !== nodes.length) throw new DomainError('DUPLICATE_STEP', '步骤名称不能重复', 400);
  const done = new Set<string>(),
    visiting = new Set<string>();
  function visit(name: string) {
    if (!graph.has(name)) throw new DomainError('DEPENDENCY_MISSING', '依赖步骤不存在', 400);
    if (visiting.has(name)) throw new DomainError('DEPENDENCY_CYCLE', '依赖关系不能形成环路', 409);
    if (done.has(name)) return;
    visiting.add(name);
    for (const dependency of graph.get(name)!) visit(dependency);
    visiting.delete(name);
    done.add(name);
  }
  for (const name of graph.keys()) visit(name);
}
