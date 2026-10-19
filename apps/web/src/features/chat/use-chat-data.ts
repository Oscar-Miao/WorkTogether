import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatBootstrap, GroupFeed } from '@team-agent/contracts';
import { chatApi } from '../../lib/chat-api.js';
import { projectPrefix, projectId } from '../../lib/project-scope.js';
import { ApiError, setCsrf } from '../../lib/api.js';
export function useChatData() {
  const [data, setData] = useState<ChatBootstrap | null>(null),
    [loading, setLoading] = useState(true),
    [groupId, setGroupId] = useState(''),
    [feed, setFeed] = useState<GroupFeed | null>(null),
    [error, setError] = useState('');
  // 登录身份变化时递增代数，让旧会话中尚未返回的请求失效。
  const generation = useRef(0);
  const selected = useRef(''),
    user = useRef(''),
    pendingBootstrap = useRef<Promise<void> | null>(null),
    historyComplete = useRef(false);
  const fail = useCallback((error: any) => {
    if (
      error instanceof ApiError &&
      (error.status === 401 || error.code === 'PROJECT_UNAVAILABLE')
    ) {
      generation.current++;
      user.current = '';
      selected.current = '';
      setData(null);
      setFeed(null);
      setGroupId('');
      setCsrf('');
      window.dispatchEvent(new Event('team-agent:identity-change'));
      if (error.code === 'PROJECT_UNAVAILABLE')
        setError('当前项目不可访问，请选择已加入的团队或接受新邀请。');
    } else {
      if (error instanceof ApiError && error.code === 'GROUP_UNAVAILABLE') setFeed(null);
      setError(error.message);
    }
  }, []);
  const refresh = useCallback(async () => {
    if (pendingBootstrap.current) return pendingBootstrap.current;
    const epoch = generation.current;
    const work = (async () => {
      try {
        const result = await chatApi<ChatBootstrap>('/bootstrap');
        if (epoch !== generation.current) return;
        setCsrf(result.user.csrf);
        user.current = result.user.id;
        setData(result);
        if (!selected.current || !result.groups.some((g) => g.id === selected.current)) {
          let saved = '';
          try {
            saved =
              localStorage.getItem('common-chat-current:' + result.user.id + ':' + projectId()) ||
              '';
          } catch {}
          const id =
            result.groups.find((g) => g.id === saved)?.id ||
            result.groups.find((g) => g.id === 'conv_general')?.id ||
            result.groups[0]?.id ||
            '';
          setFeed(null);
          historyComplete.current = false;
          selected.current = id;
          setGroupId(id);
        }
      } catch (e) {
        fail(e);
      } finally {
        setLoading(false);
      }
    })();
    pendingBootstrap.current = work;
    try {
      await work;
    } finally {
      pendingBootstrap.current = null;
    }
  }, [fail]);
  const loadFeed = useCallback(async () => {
    const id = selected.current,
      who = user.current;
    if (!id || !who) return;
    try {
      const next = await chatApi<GroupFeed>('/groups/' + id + '/feed');
      // 切群或切账号后，旧请求不能覆盖当前群的消息。
      if (selected.current !== id || user.current !== who) return;
      setFeed((old) => {
        if (!old) {
          historyComplete.current = !next.next_before;
          return next;
        }
        // 实时刷新只更新最新一页，按消息 ID 合并以保留已经加载的历史。
        const messages = [
          ...new Map([...old.messages, ...next.messages].map((m) => [m.id, m])).values(),
        ].sort((a, b) => a.seq - b.seq);
        return {
          ...next,
          messages,
          next_before: historyComplete.current ? null : messages[0]?.seq || null,
        };
      });
    } catch (e) {
      fail(e);
    }
  }, [fail]);
  function select(id: string) {
    try {
      localStorage.setItem('common-chat-current:' + user.current + ':' + projectId(), id);
    } catch {}
    selected.current = id;
    historyComplete.current = false;
    setFeed(null);
    setGroupId(id);
  }
  async function more() {
    const id = selected.current;
    if (!feed?.messages.length) return;
    const next = await chatApi<GroupFeed>('/groups/' + id + '/feed?before=' + feed.messages[0].seq);
    if (id !== selected.current) return;
    historyComplete.current = !next.next_before;
    setFeed((old) =>
      old
        ? {
            ...old,
            messages: [
              ...new Map([...next.messages, ...old.messages].map((m) => [m.id, m])).values(),
            ].sort((a, b) => a.seq - b.seq),
            next_before: next.next_before,
          }
        : next,
    );
  }
  const reload = useCallback(async () => {
    await Promise.all([refresh(), loadFeed()]);
  }, [refresh, loadFeed]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (groupId) void loadFeed();
  }, [groupId, loadFeed]);
  useEffect(() => {
    if (!data) return;
    const timer = setInterval(() => void reload(), 3000);
    // SSE 只通知有变化，实际数据仍经带权限校验的接口读取；轮询作为补偿。
    const stream = new EventSource(projectPrefix() + '/api/v2/events');
    stream.addEventListener('refresh', () => void reload());
    return () => {
      clearInterval(timer);
      stream.close();
    };
  }, [!!data, reload]);
  return {
    data,
    feed,
    loading,
    groupId,
    select,
    refresh,
    reload,
    more,
    error,
    setError,
    logout: () => {
      window.dispatchEvent(new Event('team-agent:identity-change'));
      generation.current++;
      user.current = '';
      selected.current = '';
      setData(null);
      setFeed(null);
      setGroupId('');
    },
  };
}
