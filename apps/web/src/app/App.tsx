import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  Command,
  MessageSquare,
  Target,
  Laptop,
  Users,
  Plus,
  Search,
  X,
  LogOut,
  Sparkles,
  Paperclip,
  ChevronRight,
  BookOpen,
  Building2,
  Menu,
  ArrowDown,
} from 'lucide-react';
import type { Goal, SourceSummary, Message } from '@team-agent/contracts';
import { mentionLabel } from '@team-agent/domain';
import { api, setCsrf } from '../lib/api.js';
import { chatApi } from '../lib/chat-api.js';
import { Button, Field, Modal } from '../components/ui.js';
import { LoginView } from '../features/auth/LoginView.js';
import { AccountGate } from '../features/auth/AccountGate.js';
import { TeamDialog } from '../features/organization/TeamDialog.js';
import { useChatData } from '../features/chat/use-chat-data.js';
import { ChatComposer } from '../features/chat/ChatComposer.js';
import { GroupDialog } from '../features/chat/GroupDialog.js';
import { GoalCard, type GoalAction } from '../features/chat/GoalCard.js';
import { GoalDialog } from '../features/chat/GoalDialog.js';
import { GoalDetailPanel } from '../features/chat/GoalDetailPanel.js';
import { NodePanel } from '../features/chat/NodePanel.js';
import { ResourcePanel } from '../features/chat/ResourcePanel.js';
import { ProjectSelector } from '../features/organization/ProjectControls.js';
import { AdvancedGroupPanel } from '../features/chat/AdvancedGroupPanel.js';
type Panel = 'context' | 'members' | 'goal' | 'node' | 'resource' | null;
function MessageBody({ message }: { message: Message }) {
  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  for (const mention of message.mentions || []) {
    nodes.push(message.body.slice(cursor, mention.start));
    nodes.push(
      <mark key={mention.start} className={mention.type}>
        {message.body.slice(mention.start, mention.end)}
      </mark>,
    );
    cursor = mention.end;
  }
  nodes.push(message.body.slice(cursor));
  return <p className="c-message-text">{nodes}</p>;
}
export function App() {
  return (
    <AccountGate>
      <ChatApplication />
    </AccountGate>
  );
}
function ChatApplication() {
  const { data, feed, loading, groupId, select, refresh, reload, more, error, setError, logout } =
    useChatData();
  const [panel, setPanel] = useState<Panel>(() =>
      matchMedia('(min-width:1181px)').matches ? 'context' : null,
    ),
    [mobileGroups, setMobileGroups] = useState(false),
    [search, setSearch] = useState(''),
    [groupsOpen, setGroupsOpen] = useState(false),
    [teamOpen, setTeamOpen] = useState(false),
    [goalId, setGoalId] = useState(''),
    [goalForm, setGoalForm] = useState<{ goal: Goal; action: GoalAction } | null>(null),
    [mentionTarget, setMentionTarget] = useState<{ name: string; nonce: number } | null>(null),
    [invitation, setInvitation] = useState<{ token: string; expires_at: string } | null>(null),
    [resource, setResource] = useState<SourceSummary | null>(null),
    [addSource, setAddSource] = useState(false),
    [sourceName, setSourceName] = useState(''),
    [sourceBody, setSourceBody] = useState(''),
    [sourceBusy, setSourceBusy] = useState(false),
    [jump, setJump] = useState(0),
    [newMessages, setNewMessages] = useState(false),
    [referenceTarget, setReferenceTarget] = useState<{
      id: string;
      name: string;
      version: number;
      nonce: number;
    } | null>(null);
  const timeline = useRef<HTMLDivElement>(null),
    sideBody = useRef<HTMLDivElement>(null),
    follow = useRef(true),
    oldest = useRef<number | null>(null),
    oldHeight = useRef(0);
  const contextActive = ['context', 'goal', 'resource'].includes(panel || '');
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('dialog[open]')) {
        setPanel(null);
        setMobileGroups(false);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(''), 8000);
    return () => clearTimeout(timer);
  }, [error]);
  useEffect(() => {
    follow.current = true;
    oldest.current = null;
    setNewMessages(false);
  }, [groupId]);
  useLayoutEffect(() => {
    const el = timeline.current;
    if (!el) return;
    if (oldest.current !== null && feed?.messages[0]?.seq !== oldest.current) {
      el.scrollTop += el.scrollHeight - oldHeight.current;
      oldest.current = null;
      return;
    }
    if (follow.current) {
      el.scrollTop = el.scrollHeight;
      setNewMessages(false);
    } else setNewMessages(true);
  }, [
    feed?.messages.at(-1)?.id,
    feed?.goals.map((g) => g.id + g.state).join(','),
    feed?.messages[0]?.id,
  ]);
  useEffect(() => {
    if (jump && panel === 'context' && sideBody.current) {
      const section = document.getElementById('shared-documents');
      if (section) sideBody.current.scrollTop = section.offsetTop;
    }
  }, [jump, panel]);
  function toggle(next: Panel) {
    setMobileGroups(false);
    setJump(0);
    setPanel((old) =>
      old === next || (next === 'context' && ['goal', 'resource'].includes(old || ''))
        ? null
        : next,
    );
  }
  function chooseGroup(id: string) {
    setMentionTarget(null);
    setReferenceTarget(null);
    select(id);
    setMobileGroups(false);
    setJump(0);
    if (matchMedia('(max-width:760px)').matches) setPanel(null);
    else if (['goal', 'resource'].includes(panel || '')) setPanel('context');
  }
  async function joined(id: string) {
    await refresh();
    chooseGroup(id);
    setGroupsOpen(false);
  }
  function onAction(goal: Goal, action: GoalAction) {
    if (action === 'detail') {
      setGoalId(goal.id);
      setMobileGroups(false);
      setPanel('goal');
    } else setGoalForm({ goal, action });
  }
  function reference(source: SourceSummary) {
    setReferenceTarget({ ...source, nonce: Date.now() });
    if (matchMedia('(max-width:1180px)').matches) setPanel(null);
  }
  function mention(name: string) {
    setMentionTarget({ name, nonce: Date.now() });
    if (matchMedia('(max-width:1180px)').matches) setPanel(null);
  }
  async function showInvite() {
    try {
      setInvitation(await chatApi('/groups/' + groupId + '/invites', {}));
    } catch (e: any) {
      setError(e.message);
    }
  }
  async function createSource() {
    setSourceBusy(true);
    try {
      await api('/sources', { name: sourceName, content: sourceBody, visibility: 'shared' });
      await refresh();
      setAddSource(false);
      setSourceName('');
      setSourceBody('');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSourceBusy(false);
    }
  }
  if (loading)
    return (
      <div className="boot-screen">
        <Command size={28} />
        <p>正在连接工作空间…</p>
      </div>
    );
  if (!data) return <LoginView onSuccess={refresh} initialError={error} />;
  const group = data.groups.find((g) => g.id === groupId),
    device =
      data.devices.find((d) => d.id === data.leadership?.node_id) ||
      data.devices.find((d) => d.status !== 'revoked');
  const events = [
    ...(feed?.messages || []).map((m) => ({
      kind: 'message' as const,
      id: m.id,
      at: m.created_at,
      message: m,
    })),
    ...(feed?.goals || []).map((g) => ({
      kind: 'goal' as const,
      id: g.id,
      at: g.created_at,
      goal: g,
    })),
  ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime() || a.id.localeCompare(b.id));
  const panelTitle =
    panel === 'members'
      ? '群成员'
      : panel === 'node'
        ? 'Owner 主设备'
        : panel === 'goal'
          ? '目标、依据与成果'
          : panel === 'resource'
            ? '项目资料'
            : '协作上下文';
  return (
    <div className="c-app">
      {teamOpen && <TeamDialog onClose={() => setTeamOpen(false)} />}
      <div className="c-topline">
        <span>共域 / 团队协作</span>
        <span>
          {data.coordinator.model_configured
            ? '主 Agent 目标理解已配置'
            : '规则观察模式 · 未启用目标理解模型'}
        </span>
      </div>
      <div className={'c-workspace ' + (panel ? 'panel-open' : '')}>
        <nav className="c-rail" aria-label="主导航">
          <div className="c-brand">
            <Command size={23} />
          </div>
          <button
            className="active"
            aria-label="群聊"
            aria-current="page"
            onClick={() => {
              if (matchMedia('(max-width:760px)').matches) {
                setPanel(null);
                setMobileGroups((v) => !v);
              }
            }}
          >
            <MessageSquare size={20} />
          </button>
          <button
            className={contextActive ? 'active' : ''}
            aria-label="协作上下文与项目资料"
            aria-pressed={contextActive}
            aria-expanded={contextActive}
            aria-controls="chat-sidebar"
            onClick={() => toggle('context')}
          >
            <Target size={20} />
          </button>
          <div className="c-rail-bottom">
            <button
              aria-label="团队与项目"
              title="创建团队、加入团队与邀请成员"
              onClick={() => setTeamOpen(true)}
            >
              <Users size={20} />
            </button>
            <button
              className={panel === 'node' ? 'active' : ''}
              aria-label="主设备状态"
              aria-pressed={panel === 'node'}
              onClick={() => toggle('node')}
            >
              <Laptop size={20} />
            </button>
            <button
              className="c-self"
              aria-label="退出登录"
              title={
                data.user.name + ' · ' + (data.user.role === 'OWNER' ? '项目维护者' : '团队成员')
              }
              onClick={() =>
                void api('/auth/logout', {}).then(() => {
                  logout();
                  setCsrf('');
                })
              }
            >
              <LogOut size={18} />
            </button>
          </div>
        </nav>
        {mobileGroups && (
          <button
            className="c-scrim c-group-scrim"
            aria-label="关闭群聊列表"
            onClick={() => setMobileGroups(false)}
          />
        )}
        <aside className={'c-groups ' + (mobileGroups ? 'open' : '')} aria-label="群聊列表">
          <div className="c-space">
            <span className="c-space-icon">
              <Users size={21} />
            </span>
            <div>
              <strong>{data.project.workspace}</strong>
              <small>{data.project.name}</small>
            </div>
            <ProjectSelector />
            <button
              className="c-mobile-only c-icon"
              aria-label="收起群聊列表"
              onClick={() => setMobileGroups(false)}
            >
              <X size={17} />
            </button>
          </div>
          <div className="c-search">
            <Search size={16} />
            <input
              aria-label="搜索群聊"
              placeholder="搜索群聊…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <button aria-label="创建或加入群聊" onClick={() => setGroupsOpen(true)}>
              <Plus size={19} />
            </button>
          </div>
          <div className="c-list-label">
            <span>我的群聊</span>
            <span>{data.groups.length.toString().padStart(2, '0')}</span>
          </div>
          <div className="c-group-list">
            {data.groups
              .filter((g) => g.title.toLowerCase().includes(search.toLowerCase()))
              .map((g) => (
                <button
                  key={g.id}
                  className={'c-group ' + (groupId === g.id ? 'selected' : '')}
                  onClick={() => chooseGroup(g.id)}
                  aria-label={'打开群聊 ' + g.title}
                >
                  <span className="c-group-avatar">
                    {g.title.slice(0, 1)}
                    <i />
                  </span>
                  <span>
                    <strong>{g.title}</strong>
                    <small>{g.latest_message || '主 Agent 已参与，开始一起讨论'}</small>
                  </span>
                  <time>
                    {new Date(g.created_at).toLocaleDateString('zh-CN', {
                      month: '2-digit',
                      day: '2-digit',
                    })}
                  </time>
                </button>
              ))}
            {!data.groups.some((g) => g.title.toLowerCase().includes(search.toLowerCase())) && (
              <p className="c-muted c-padding">没有匹配的已加入群聊。</p>
            )}
          </div>
          <button className="c-discover" onClick={() => setGroupsOpen(true)}>
            <Plus size={16} />
            发现与加入群聊
            <ChevronRight size={16} />
          </button>
          <footer>
            <span className="c-self-avatar">{data.user.name.slice(0, 1)}</span>
            <div>
              {data.user.name}
              <small>{data.user.role === 'OWNER' ? '项目维护者' : '团队成员'}</small>
            </div>
          </footer>
        </aside>
        <main className="c-chat">
          <header className="c-chat-head">
            <button
              className="c-icon c-mobile-only"
              aria-label="打开群聊列表"
              onClick={() => {
                setPanel(null);
                setMobileGroups(true);
              }}
            >
              <Menu size={20} />
            </button>
            <div className="c-chat-title">
              <h1>{group?.title || '团队群聊'}</h1>
              <p>
                {feed?.members.length ?? group?.member_count ?? 0} 位成员 · 主 Agent 参与 ·
                把需求、分工与进展放在一起
              </p>
            </div>
            <button
              className={'c-node-status ' + (device?.status === 'online' ? 'online' : '')}
              onClick={() => toggle('node')}
              aria-label="Owner 主设备状态"
            >
              <i />
              {device?.status === 'online' ? '主设备 在线' : '主设备 未就绪'}
            </button>
            <div className="c-head-tools">
              <button
                className="c-icon c-mobile-only"
                aria-label="团队与项目"
                onClick={() => setTeamOpen(true)}
              >
                <Building2 size={20} />
              </button>
              <button
                className={'c-icon ' + (panel === 'members' ? 'active' : '')}
                aria-label="群成员"
                aria-pressed={panel === 'members'}
                onClick={() => toggle('members')}
              >
                <Users size={20} />
              </button>
              <button
                className={'c-icon ' + (contextActive ? 'active' : '')}
                aria-label="查看协作上下文"
                aria-pressed={contextActive}
                onClick={() => toggle('context')}
              >
                <Target size={20} />
              </button>
            </div>
          </header>
          <div
            className="c-timeline"
            ref={timeline}
            aria-label="群消息与协作记录"
            onScroll={() => {
              const el = timeline.current!;
              follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 70;
              if (follow.current) setNewMessages(false);
            }}
          >
            <div className="c-day">团队协作记录</div>
            {feed?.next_before && (
              <button
                className="c-load"
                onClick={() => {
                  if (timeline.current) {
                    oldest.current = feed.messages[0]?.seq;
                    oldHeight.current = timeline.current.scrollHeight;
                    follow.current = false;
                  }
                  void more().catch((e) => setError(e.message));
                }}
              >
                加载更早消息
              </button>
            )}
            {!feed ? (
              <p className="c-muted c-padding">正在同步群消息…</p>
            ) : !events.length ? (
              <div className="c-welcome">
                <Sparkles size={28} />
                <h2>从一段讨论开始协作</h2>
                <p>告诉团队你在做什么，或 @AI 推进一个目标。主 Agent 会先比较已登记的工作。</p>
              </div>
            ) : (
              events.map((event) =>
                event.kind === 'message' ? (
                  <article className="c-message" key={event.id}>
                    <span className="c-avatar">{event.message.author_name.slice(0, 1)}</span>
                    <div>
                      <header>
                        <strong>{event.message.author_name}</strong>
                        <time>
                          {new Date(event.at).toLocaleTimeString('zh-CN', {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </time>
                      </header>
                      <MessageBody message={event.message} />
                    </div>
                  </article>
                ) : (
                  <article className="c-message c-agent-message" key={event.id}>
                    <span className="c-avatar agent">
                      <Sparkles size={18} />
                    </span>
                    <div>
                      <header>
                        <strong>共域 Agent</strong>
                        <small>协调记录</small>
                        <time>
                          {new Date(event.at).toLocaleTimeString('zh-CN', {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </time>
                      </header>
                      <GoalCard goal={event.goal} onAction={onAction} />
                    </div>
                  </article>
                ),
              )
            )}
          </div>
          {newMessages && (
            <button
              className="c-new-message"
              onClick={() => {
                follow.current = true;
                timeline.current?.scrollTo({ top: timeline.current.scrollHeight });
                setNewMessages(false);
              }}
            >
              <ArrowDown size={14} />
              有新的协作记录
            </button>
          )}
          {group?.archived_at && (
            <p className="c-panel-note" role="status">
              此群已归档。恢复群聊后可继续讨论与委托。
            </p>
          )}
          {groupId && feed && !group?.archived_at && (
            <ChatComposer
              key={data.user.id + groupId}
              groupId={groupId}
              userId={data.user.id}
              members={feed.members}
              observe={
                group?.agent_policy?.observe !== false && group?.agent_policy?.mode !== 'passive'
              }
              onSent={async () => {
                follow.current = true;
                await reload();
              }}
              onError={setError}
              onDocs={() => {
                setMobileGroups(false);
                setPanel('context');
                setJump((v) => v + 1);
              }}
              mentionTarget={mentionTarget}
              referenceTarget={referenceTarget}
            />
          )}
        </main>
        {panel && (
          <>
            <button
              className="c-scrim c-panel-scrim"
              aria-label="收起右侧栏遮罩"
              onClick={() => setPanel(null)}
            />
            <aside className="c-panel" id="chat-sidebar" aria-label={panelTitle}>
              <header className="c-panel-head">
                {panel === 'members' ? (
                  <Users size={16} />
                ) : panel === 'node' ? (
                  <Laptop size={16} />
                ) : (
                  <Target size={16} />
                )}
                <h2>{panelTitle}</h2>
                <button className="c-icon" aria-label="关闭右侧栏" onClick={() => setPanel(null)}>
                  <X size={17} />
                </button>
              </header>
              <div className="c-panel-tabs">
                <button
                  className={contextActive ? 'active' : ''}
                  onClick={() => {
                    setPanel('context');
                    setJump(0);
                  }}
                >
                  协作上下文
                </button>
                <button
                  className={panel === 'members' ? 'active' : ''}
                  onClick={() => setPanel('members')}
                >
                  群成员
                </button>
                <button
                  className={panel === 'node' ? 'active' : ''}
                  onClick={() => setPanel('node')}
                >
                  主设备
                </button>
              </div>
              <div className="c-panel-body" ref={sideBody}>
                {panel === 'context' ? (
                  <>
                    <section className="c-observer">
                      <strong>
                        <Sparkles size={15} />主 Agent 持续关注中
                      </strong>
                      <p>把群内讨论与团队已有工作连起来，先看是否重复，再决定如何推进。</p>
                      <footer>
                        <span>已观察至消息 #{feed?.observed_seq || 0}</span>
                        <span>
                          {feed?.jobs_pending
                            ? feed.jobs_pending + ' 条待理解'
                            : data.coordinator.model_configured
                              ? '模型观察'
                              : '规则观察'}
                        </span>
                      </footer>
                    </section>
                    {!!feed?.jobs_failed && (
                      <p className="c-observation-error">
                        有 {feed.jobs_failed} 条观察失败。
                        <button
                          onClick={() =>
                            void chatApi('/groups/' + groupId + '/retry-observation', {})
                              .then(reload)
                              .catch((e) => setError(e.message))
                          }
                        >
                          重试观察
                        </button>
                      </p>
                    )}
                    <div className="c-section-label">
                      当前群的协作目标<span>{feed?.goals.length || 0}</span>
                    </div>
                    {feed?.goals.map((g) => (
                      <GoalCard key={g.id} goal={g} onAction={onAction} compact />
                    ))}
                    {!feed?.goals.length && (
                      <p className="c-muted">尚无已登记工作。讨论中可说“我来做…”并确认认领。</p>
                    )}
                    <section className="c-shared" id="shared-documents">
                      <div className="c-section-label">
                        项目共享资料
                        {data.user.role === 'OWNER' && (
                          <button onClick={() => setAddSource(true)}>
                            <Plus size={13} />
                            添加
                          </button>
                        )}
                      </div>
                      {data.sources
                        .filter((s) => s.visibility === 'shared')
                        .map((s) => (
                          <div className="c-doc" key={s.id}>
                            <button
                              onClick={() => {
                                setResource(s);
                                setPanel('resource');
                              }}
                            >
                              <BookOpen size={15} />
                              <strong>{s.name}</strong>
                              <small>v{s.version}</small>
                            </button>
                            <p>{s.preview.slice(0, 100)}</p>
                            <button
                              className="c-text-button"
                              onClick={() => {
                                setResource(s);
                                setPanel('resource');
                              }}
                            >
                              查看资料
                            </button>{' '}
                            <button className="c-text-button" onClick={() => reference(s)}>
                              引用到消息
                            </button>
                          </div>
                        ))}
                      {!data.sources.some((s) => s.visibility === 'shared') && (
                        <p className="c-muted">
                          共享资料添加后可在此读取，模型不会隐式获得私有资料。
                        </p>
                      )}
                    </section>
                    <section className="c-shared">
                      <div className="c-section-label">项目结论与记忆</div>
                      {data.memories.slice(0, 20).map((m) => (
                        <details key={m.id}>
                          <summary>
                            {m.title} ·{' '}
                            {m.status === 'confirmed'
                              ? '已确认'
                              : m.status === 'candidate'
                                ? '待确认'
                                : '已失效'}
                          </summary>
                          <p className="c-resource">{m.content}</p>
                        </details>
                      ))}
                      {!data.memories.length && <p className="c-muted">暂无确认的项目结论。</p>}
                    </section>
                  </>
                ) : panel === 'members' ? (
                  <>
                    <p className="c-panel-note">
                      {group?.title} · {feed?.members.length || 0} 位成员与主 Agent
                    </p>
                    {feed?.members.map((m) => (
                      <div className="c-member" key={m.id}>
                        <span className="c-avatar">{m.name.slice(0, 1)}</span>
                        <div>
                          <strong>
                            {m.name}
                            {m.id === data.user.id ? '（你）' : ''}
                          </strong>
                          <small>
                            {m.id === (group?.manager_id || group?.created_by) ? '群管理者 · ' : ''}
                            {m.role === 'OWNER' ? '项目维护者' : '项目成员'}
                          </small>
                        </div>
                        <button
                          aria-label={'提及群成员 ' + m.name}
                          onClick={() => mention(mentionLabel(m, feed.members))}
                        >
                          {' '}
                          @{' '}
                        </button>
                      </div>
                    ))}
                    <div className="c-member">
                      <span className="c-avatar agent">
                        <Sparkles size={17} />
                      </span>
                      <div>
                        <strong>共域 Agent</strong>
                        <small>主设备上的协调 Agent</small>
                      </div>
                      <button aria-label="提及 AI" onClick={() => mention('AI')}>
                        {' '}
                        @{' '}
                      </button>
                    </div>
                    {group && (
                      <AdvancedGroupPanel
                        key={group.id}
                        group={group}
                        userId={data.user.id}
                        members={feed?.members || []}
                        onRefresh={refresh}
                        onChoose={(id) => void joined(id)}
                      />
                    )}
                    <Button variant="secondary" onClick={() => void showInvite()}>
                      查看群邀请码
                    </Button>
                  </>
                ) : panel === 'goal' ? (
                  <GoalDetailPanel
                    id={goalId}
                    onAction={onAction}
                    userId={data.user.id}
                    members={feed?.members || []}
                    repositories={data.devices
                      .filter((d) => d.status !== 'revoked')
                      .flatMap((d) => d.repositories)}
                    isAdmin={data.user.role === 'OWNER'}
                  />
                ) : panel === 'node' ? (
                  <NodePanel
                    key={data.policy_version}
                    data={data}
                    onRefresh={refresh}
                    onError={setError}
                  />
                ) : (
                  resource && (
                    <>
                      <ResourcePanel
                        id={resource.id}
                        version={resource.version}
                        canEdit={data.user.role === 'OWNER'}
                        onRefresh={refresh}
                        onVersion={(s) =>
                          setResource((old) =>
                            old
                              ? { ...old, version: s.version, preview: s.content.slice(0, 400) }
                              : null,
                          )
                        }
                      />
                      <Button variant="secondary" onClick={() => reference(resource)}>
                        引用到消息
                      </Button>
                    </>
                  )
                )}
              </div>
            </aside>
          </>
        )}
      </div>
      {groupsOpen && <GroupDialog onClose={() => setGroupsOpen(false)} onJoined={joined} />}
      {goalForm && <GoalDialog {...goalForm} onClose={() => setGoalForm(null)} onDone={reload} />}
      {invitation && (
        <Modal title="本群邀请码" onClose={() => setInvitation(null)}>
          <div className="modal-body">
            <p>项目成员可使用此码加入本群，24 小时内有效。</p>
            <pre className="c-invite-code">{invitation.token}</pre>
            <Button
              onClick={() =>
                void navigator.clipboard
                  .writeText(invitation.token)
                  .then(() => setError('邀请码已复制'))
                  .catch(() => setError('剪贴板不可用，请手动复制'))
              }
            >
              复制邀请码
            </Button>
          </div>
        </Modal>
      )}
      {addSource && (
        <Modal title="添加共享资料" onClose={() => setAddSource(false)}>
          <form
            className="modal-body"
            onSubmit={(e) => {
              e.preventDefault();
              void createSource();
            }}
          >
            <Field label="资料名称">
              <input
                required
                maxLength={120}
                value={sourceName}
                onChange={(e) => setSourceName(e.target.value)}
              />
            </Field>
            <Field label="资料正文">
              <textarea
                required
                rows={10}
                value={sourceBody}
                onChange={(e) => setSourceBody(e.target.value)}
              />
            </Field>
            <div className="modal-actions">
              <Button type="submit" busy={sourceBusy}>
                添加资料
              </Button>
            </div>
          </form>
        </Modal>
      )}
      {error && (
        <div className="c-toast" role="status">
          {error}
          <button aria-label="关闭提示" onClick={() => setError('')}>
            <X size={16} />
          </button>
        </div>
      )}
    </div>
  );
}
