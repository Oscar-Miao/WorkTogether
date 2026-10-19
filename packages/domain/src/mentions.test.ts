import { expect, test } from 'vitest';
import { extractMentions, mentionSafeText } from './mentions.js';
test('same-name members and a human named AI keep unambiguous stable targets', () => {
  const people = [
    { id: 'usr_aaaaaa', name: '林可', role: 'MEMBER' },
    { id: 'usr_bbbbbb', name: '林可', role: 'MEMBER' },
    { id: 'usr_cccccc', name: 'AI', role: 'MEMBER' },
  ];
  expect(
    extractMentions('@林可#bbbbbb @AI#cccccc @AI', people).map((m) => [m.type, m.target_id]),
  ).toEqual([
    ['member', 'usr_bbbbbb'],
    ['member', 'usr_cccccc'],
    ['agent', 'coordinator'],
  ]);
  expect(extractMentions('@林可', people)).toEqual([]);
});

const members = [
  { id: 'usr_lin', name: '林可', role: 'MEMBER' },
  { id: 'usr_chen', name: '陈默', role: 'MEMBER' },
];
test('mentions use current-group identities and preserve exact text ranges', () => {
  const text = '请 @林可 与 @AI 一起检查';
  expect(extractMentions(text, members)).toEqual([
    { type: 'member', target_id: 'usr_lin', label: '林可', start: 2, end: 5 },
    { type: 'agent', target_id: 'coordinator', label: 'AI', start: 8, end: 11 },
  ]);
  expect(extractMentions('@陌生人', members)).toEqual([]);
});
test('quoted and unclosed fenced mentions do not trigger agents', () => {
  expect(extractMentions('> @AI 检查\n\n普通文字', members)).toEqual([]);
  expect(extractMentions('~~~text\n@AI 检查', members)).toEqual([]);
  expect(mentionSafeText('> @林可').length).toBe('> @林可'.length);
});
