import type { Mention, GroupMember } from '@team-agent/contracts';
export function mentionSafeText(text: string): string {
  return text
    .replace(/`{3}[\s\S]*?(?:`{3}|$)/g, (b) => b.replace(/[^\n]/g, ' '))
    .replace(/~{3}[\s\S]*?(?:~{3}|$)/g, (b) => b.replace(/[^\n]/g, ' '))
    .replace(/^[ \t]*>.*$/gm, (b) => ' '.repeat(b.length));
}
export function mentionLabel(member: GroupMember, members: GroupMember[]): string {
  return member.name.toUpperCase() === 'AI' ||
    members.filter((m) => m.name === member.name).length > 1
    ? member.name + '#' + member.id.slice(-6)
    : member.name;
}
export function extractMentions(text: string, members: GroupMember[]): Mention[] {
  const safe = mentionSafeText(text);
  const candidates = [
    { id: 'coordinator', name: 'AI', type: 'agent' as const },
    ...members.map((m) => ({ ...m, name: mentionLabel(m, members), type: 'member' as const })),
  ].sort((a, b) => b.name.length - a.name.length);
  const result: Mention[] = [];
  for (let i = 0; i < safe.length; i++) {
    if (safe[i] !== '@' || (i > 0 && !/[\s(（]/.test(safe[i - 1]))) continue;
    const item = candidates.find(
      (c) =>
        safe.slice(i + 1, i + 1 + c.name.length).toLowerCase() === c.name.toLowerCase() &&
        (!safe[i + 1 + c.name.length] ||
          /[\s，,。！？!?:：;；、)）]/.test(safe[i + 1 + c.name.length])),
    );
    if (item) {
      result.push({
        type: item.type,
        target_id: item.id,
        label: item.name,
        start: i,
        end: i + item.name.length + 1,
      });
      i += item.name.length;
    }
  }
  return result;
}
export function normalizedGoal(title: string): string {
  return title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/^\s*@ai\s*/i, '')
    .replace(/^(?:请|麻烦|帮我|帮忙|我来做|我负责|我来处理|请帮我)[：:\s]*/, '')
    .replace(/[\s\p{P}]/gu, '');
}
export function goalSimilarity(a: string, b: string): number {
  const grams = (s: string) =>
    new Set(Array.from({ length: Math.max(0, s.length - 1) }, (_, i) => s.slice(i, i + 2)));
  const x = grams(normalizedGoal(a)),
    y = grams(normalizedGoal(b));
  if (!x.size || !y.size) return 0;
  return [...x].filter((v) => y.has(v)).length / new Set([...x, ...y]).size;
}
