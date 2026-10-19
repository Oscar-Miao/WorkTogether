import { useRef, useState, useEffect, type FormEvent } from 'react';
import { AtSign, Paperclip, Send, Sparkles, X } from 'lucide-react';
import type { GroupMember, SourceRef } from '@team-agent/contracts';
import { extractMentions, mentionSafeText, mentionLabel } from '@team-agent/domain';
import { projectId } from '../../lib/project-scope.js';
import { chatApi } from '../../lib/chat-api.js';
export function ChatComposer({
  groupId,
  userId,
  members,
  onSent,
  onError,
  onDocs,
  mentionTarget,
  referenceTarget,
  observe = true,
}: {
  groupId: string;
  observe?: boolean;
  userId: string;
  members: GroupMember[];
  onSent: () => Promise<void>;
  onError: (s: string) => void;
  onDocs: () => void;
  mentionTarget: { name: string; nonce: number } | null;
  referenceTarget: { id: string; name: string; version: number; nonce: number } | null;
}) {
  // 草稿按账号和群聊隔离，正文与资料引用版本一起保存。
  const storageKey = 'common-chat-draft:' + userId + ':' + projectId() + ':' + groupId;
  function draft() {
    try {
      const raw = localStorage.getItem(storageKey) || '';
      try {
        return JSON.parse(raw);
      } catch {
        return { text: raw, refs: [] };
      }
    } catch {
      return { text: '', refs: [] };
    }
  }
  const [refs, setRefs] = useState<{ source_id: string; version: number; name: string }[]>(
    () => draft().refs || [],
  );
  const [text, setText] = useState<string>(() => draft().text || ''),
    [busy, setBusy] = useState(false),
    [picker, setPicker] = useState<{
      start: number;
      end: number;
      query: string;
      index: number;
    } | null>(null);
  const input = useRef<HTMLTextAreaElement>(null),
    key = useRef(crypto.randomUUID()),
    posting = useRef(false);
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify({ text, refs }));
    } catch {}
  }, [storageKey, text, refs]);
  useEffect(() => {
    if (referenceTarget)
      setRefs((old) => [
        ...old.filter((r) => r.source_id !== referenceTarget.id),
        {
          source_id: referenceTarget.id,
          version: referenceTarget.version,
          name: referenceTarget.name,
        },
      ]);
  }, [referenceTarget?.nonce]);
  useEffect(() => {
    if (!mentionTarget) return;
    setText((v) => v + (v && !/\s$/.test(v) ? ' ' : '') + '@' + mentionTarget.name + ' ');
    input.current?.focus();
  }, [mentionTarget?.nonce]);
  const choices = [
    { id: 'coordinator', name: 'AI' },
    ...members.map((m) => ({ ...m, name: mentionLabel(m, members) })),
  ].filter((m) => m.name.toLowerCase().includes(picker?.query.toLowerCase() || ''));
  function update(value: string, caret: number) {
    setText(value);
    const match = /(^|[\s(（])@([^\s@]*)$/.exec(mentionSafeText(value.slice(0, caret)));
    setPicker(
      match ? { start: caret - match[2].length - 1, end: caret, query: match[2], index: 0 } : null,
    );
  }
  function choose(name: string) {
    if (!picker) return;
    const next = text.slice(0, picker.start) + '@' + name + ' ' + text.slice(picker.end),
      caret = picker.start + name.length + 2;
    setText(next);
    setPicker(null);
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(caret, caret);
    });
  }
  async function submit(event?: FormEvent, invoke = false) {
    event?.preventDefault();
    if (posting.current || !text.trim()) return;
    // 发送时基于最终正文重新计算提及范围，避免编辑文本后仍沿用旧位置。
    const body = text.trim();
    posting.current = true;
    setBusy(true);
    setPicker(null);
    try {
      await chatApi(
        '/groups/' + groupId + '/messages',
        {
          body,
          client_message_id: key.current,
          mentions: extractMentions(body, members),
          invoke_agent: invoke,
          source_refs: refs.map(({ source_id, version }) => ({
            source_id,
            version,
          })) as SourceRef[],
        },
        key.current,
      );
      key.current = crypto.randomUUID();
      setText('');
      setRefs([]);
      await onSent();
    } catch (error: any) {
      onError(error.message);
    } finally {
      posting.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="c-compose-wrap">
      <div className="c-suggestions">
        <span>试试</span>
        {['我来做 发布验收文档梳理', '@AI 分析项目结构并整理风险清单'].map((t) => (
          <button
            key={t}
            onClick={() => {
              setText(t);
              input.current?.focus();
            }}
          >
            {t.startsWith('@') ? '推进一个目标' : '登记我的工作'}
          </button>
        ))}
      </div>
      <form className="c-composer" onSubmit={(e) => void submit(e)}>
        {picker && (
          <div className="c-mentions" role="listbox" id="mention-options" aria-label="提及对象">
            <small>提及 AI 或当前群成员</small>
            {choices.length ? (
              choices.map((m, i) => (
                <button
                  key={m.id}
                  type="button"
                  role="option"
                  id={'mention-' + i}
                  aria-selected={i === picker.index}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(m.name)}
                >
                  <span className="c-avatar">
                    {m.name === 'AI' ? <Sparkles size={15} /> : m.name.slice(0, 1)}
                  </span>
                  <span>
                    @{m.name}
                    <small>{m.id === 'coordinator' ? '主协调 Agent' : '群成员'}</small>
                  </span>
                </button>
              ))
            ) : (
              <p>没有匹配的群成员</p>
            )}
          </div>
        )}
        {refs.length > 0 && (
          <div className="c-reference-chips">
            {refs.map((r) => (
              <button
                type="button"
                key={r.source_id}
                onClick={() => setRefs((old) => old.filter((x) => x.source_id !== r.source_id))}
              >
                引用：{r.name} v{r.version}
                <X size={11} />
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={input}
          aria-label="群消息输入"
          aria-autocomplete="list"
          aria-controls="mention-options"
          aria-expanded={!!picker}
          aria-activedescendant={picker && choices.length ? 'mention-' + picker.index : undefined}
          value={text}
          onChange={(e) => update(e.target.value, e.target.selectionStart)}
          onClick={(e) => update(text, e.currentTarget.selectionStart)}
          onBlur={() => setTimeout(() => setPicker(null), 120)}
          placeholder="和团队聊聊，或 @AI 一起推进一个目标…"
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (picker && ['ArrowDown', 'ArrowUp'].includes(e.key) && choices.length) {
              e.preventDefault();
              setPicker({
                ...picker,
                index:
                  (picker.index + (e.key === 'ArrowDown' ? 1 : -1) + choices.length) %
                  choices.length,
              });
              return;
            }
            if (picker && (e.key === 'Enter' || e.key === 'Tab') && choices.length) {
              e.preventDefault();
              choose(choices[picker.index].name);
              return;
            }
            if (e.key === 'Escape' && picker) {
              e.preventDefault();
              e.stopPropagation();
              setPicker(null);
              return;
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <div className="c-composer-tools">
          <div>
            <button
              type="button"
              aria-label="提及 AI 或群成员"
              onClick={() => {
                const pos = input.current?.selectionStart ?? text.length;
                const next =
                  text.slice(0, pos) +
                  (pos && !/\s/.test(text[pos - 1]) ? ' @' : '@') +
                  text.slice(pos);
                update(next, next.length - (text.length - pos));
                input.current?.focus();
              }}
            >
              <AtSign size={17} />
            </button>
            <button type="button" aria-label="引用资料" onClick={onDocs}>
              <Paperclip size={17} />
            </button>
            <button
              type="button"
              aria-label="唤起 Agent"
              disabled={busy || !text.trim()}
              onClick={() => void submit(undefined, true)}
            >
              <Sparkles size={17} />
            </button>
          </div>
          <span>Enter 发送 · Shift + Enter 换行</span>
          <button
            className="c-send"
            type="submit"
            disabled={busy || !text.trim()}
            aria-label="发送消息"
          >
            <Send size={18} />
          </button>
        </div>
      </form>
      <div className="c-compose-note">
        ●{' '}
        {observe
          ? '团队讨论持续观察，明确委托后按设备策略推进'
          : '当前群暂停持续观察，可 @AI 明确委托'}
        <span>人与 Agent 一起推进</span>
      </div>
    </div>
  );
}
