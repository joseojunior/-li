import { FormEvent, useEffect, useMemo, useState } from 'react';
import { api, type AgentKey, type AgentModel, type AgentPlaybook, type AgentPromptVersion, type AiConfiguration, type BlingCatalogSyncRun, type BlingConnectionStatus, type ChatAiConnectionResult, type ChatAiTagSyncResult, type Conversation, type ConversationTag, type Message, type MessageChannel, type OperationTrace, type OperationTraceSummary, type PanelUser, type Product, type ProductInput, type PromptTestResult, type RoutingPolicy, type SalesContext } from './api';

type Section = 'inbox' | 'catalog' | 'automation' | 'traces' | 'settings';

const formatTime = (value: string) => new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(new Date(value));
const formatDate = (value: string) => new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short' }).format(new Date(value));
const formatPrice = (cents: number | null, currency: string) => cents === null ? 'Sob consulta' : new Intl.NumberFormat('pt-BR', { style: 'currency', currency }).format(cents / 100);

export default function App() {
  const [user, setUser] = useState<PanelUser | null>(null);
  const [initializing, setInitializing] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    api.me().then(setUser).catch(() => setUser(null)).finally(() => setInitializing(false));
  }, []);

  if (initializing) return <div className="splash"><span className="brand-mark">L</span><p>Abrindo operação…</p></div>;
  if (!user) return <Login onLogin={setUser} />;
  return <Workspace user={user} onLogout={() => api.logout().finally(() => setUser(null))} globalError={error} clearError={() => setError('')} onError={setError} />;
}

function Login({ onLogin }: { onLogin: (user: PanelUser) => void }) {
  const [organizationSlug, setOrganizationSlug] = useState(import.meta.env.VITE_DEFAULT_ORGANIZATION_SLUG ?? 'lilibag-local');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setLoading(true); setError('');
    try { onLogin(await api.login(organizationSlug, email, password)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Erro ao entrar.'); }
    finally { setLoading(false); }
  }

  return <main className="login-shell">
    <section className="login-aside"><span className="brand-mark">L</span><p className="eyebrow">Lilibag · Operação</p><h1>Conversas que viram cuidado.</h1><p>Atenda clientes, acompanhe filas e mantenha o catálogo ao alcance da equipe.</p></section>
    <form className="login-card" onSubmit={submit}>
      <div><p className="eyebrow">Acesso da equipe</p><h2>Entrar no painel</h2><p className="muted">Use as credenciais criadas pelo administrador.</p></div>
      <label>Loja<input value={organizationSlug} onChange={(event) => setOrganizationSlug(event.target.value)} autoComplete="organization" placeholder="lilibag-local" required /><small>Use o slug definido para a organização.</small></label>
      <label>E-mail<input value={email} onChange={(event) => setEmail(event.target.value)} type="email" autoComplete="email" required /></label>
      <label>Senha<input value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete="current-password" required /></label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="button primary" disabled={loading}>{loading ? 'Entrando…' : 'Entrar'}</button>
    </form>
  </main>;
}

function Workspace({ user, onLogout, globalError, clearError, onError }: { user: PanelUser; onLogout: () => void; globalError: string; clearError: () => void; onError: (message: string) => void }) {
  const [section, setSection] = useState<Section>('inbox');
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="identity"><span className="brand-mark">L</span><span><strong>Lilibag</strong><small>Operação</small></span></div>
      <nav aria-label="Navegação principal">
        <NavItem active={section === 'inbox'} onClick={() => setSection('inbox')} icon="◒" label="Atendimento" />
        <NavItem active={section === 'catalog'} onClick={() => setSection('catalog')} icon="▧" label="Catálogo" />
        <NavItem active={section === 'automation'} onClick={() => setSection('automation')} icon="✦" label="Agente e regras" />
        {['owner', 'admin'].includes(user.role) && <NavItem active={section === 'traces'} onClick={() => setSection('traces')} icon="≋" label="Trace" />}
        <NavItem active={section === 'settings'} onClick={() => setSection('settings')} icon="◌" label="Integrações" />
      </nav>
      <div className="sidebar-footer"><span className="avatar">{user.displayName.slice(0, 1).toUpperCase()}</span><span><strong>{user.displayName}</strong><small>{user.role}</small></span><button className="icon-button" onClick={onLogout} aria-label="Sair">↗</button></div>
    </aside>
    <main className="content">
      {globalError && <div className="notice error"><span>{globalError}</span><button onClick={clearError}>×</button></div>}
      {section === 'inbox' && <Inbox user={user} onError={onError} />}
      {section === 'catalog' && <Catalog user={user} onError={onError} />}
      {section === 'automation' && <AgentRulesCenter user={user} onError={onError} />}
      {section === 'traces' && <TraceDashboard onError={onError} />}
      {section === 'settings' && <IntegrationHub user={user} onError={onError} />}
    </main>
  </div>;
}

function NavItem({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: string; label: string }) {
  return <button className={`nav-item ${active ? 'active' : ''}`} onClick={onClick}><span>{icon}</span>{label}</button>;
}

function Inbox({ user, onError }: { user: PanelUser; onError: (message: string) => void }) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selected, setSelected] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    setLoading(true);
    try { const data = (await api.conversations()).data; setConversations(data); setSelected((current) => data.find((item) => item.id === current?.id) ?? data[0] ?? null); }
    catch (reason) { onError(reason instanceof Error ? reason.message : 'Não foi possível carregar atendimentos.'); }
    finally { setLoading(false); }
  };
  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    if (!selected) { setMessages([]); return; }
    api.messages(selected.id).then((result) => setMessages(result.data)).catch((reason) => onError(reason instanceof Error ? reason.message : 'Não foi possível carregar as mensagens.'));
  }, [selected?.id]);

  const openCount = useMemo(() => conversations.filter((item) => item.status === 'open').length, [conversations]);
  return <section className="inbox-layout">
    <header className="page-header"><div><p className="eyebrow">Atendimento</p><h1>Caixa de entrada</h1></div><div className="header-actions"><span className="metric"><strong>{openCount}</strong> abertas</span><button className="button secondary" onClick={() => void refresh()}>Atualizar</button></div></header>
    <div className="inbox-grid">
      <aside className="conversation-list"><div className="list-heading"><strong>Conversas</strong><span>{loading ? '…' : conversations.length}</span></div>{!loading && conversations.length === 0 && <Empty title="Ainda não há conversas" text="Quando o canal receber uma mensagem, ela aparecerá aqui." />}
        {conversations.map((conversation) => <button key={conversation.id} className={`conversation-row ${selected?.id === conversation.id ? 'selected' : ''}`} onClick={() => setSelected(conversation)}><span className="avatar soft">{(conversation.contact_name ?? conversation.phone_e164 ?? '?').slice(0, 1).toUpperCase()}</span><span className="conversation-copy"><strong>{conversation.contact_name ?? conversation.phone_e164 ?? 'Contato sem nome'}</strong><small>{conversation.channel_name} · {formatDate(conversation.last_message_at)}</small></span><span className={`status-dot ${conversation.status}`} title={conversation.status} /></button>)}</aside>
      <ConversationView conversation={selected} messages={messages} onError={onError} onChanged={refresh} canEditTags={['owner', 'admin', 'agent'].includes(user.role)} />
    </div>
  </section>;
}

function TraceDashboard({ onError }: { onError: (message: string) => void }) {
  const [traces, setTraces] = useState<OperationTrace[]>([]);
  const [summary, setSummary] = useState<OperationTraceSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'webhook' | 'queue' | 'agent' | 'failed'>('all');
  const [selectedExecutionId, setSelectedExecutionId] = useState<string | null>(null);
  const refresh = async () => {
    setLoading(true);
    try {
      const [events, metrics] = await Promise.all([api.operationTraces(), api.operationTraceSummary()]);
      setTraces(events.data);
      setSummary(metrics);
    } catch (reason) { onError(reason instanceof Error ? reason.message : 'Não foi possível carregar o trace operacional.'); }
    finally { setLoading(false); }
  };
  useEffect(() => { void refresh(); }, []);
  const executions = useMemo(() => buildTraceExecutions(traces), [traces]);
  const visibleExecutions = executions.filter((execution) => matchesTraceFilter(execution, filter));
  const selectedExecution = visibleExecutions.find((execution) => execution.id === selectedExecutionId) ?? null;
  return <TraceExecutionList summary={summary} loading={loading} filter={filter} executions={visibleExecutions} selectedExecution={selectedExecution} onRefresh={refresh} onFilterChange={(nextFilter) => { setFilter(nextFilter); setSelectedExecutionId(null); }} onSelect={setSelectedExecutionId} onClose={() => setSelectedExecutionId(null)} />;
  /*
    <header className="page-header"><div><p className="eyebrow">Observabilidade</p><h1>Trace operacional</h1><p className="page-description">Acompanhe cada etapa sem expor conteúdo, credenciais ou tokens das clientes.</p></div><div className="header-actions"><span className="metric"><strong>{summary?.total ?? 0}</strong> eventos · 24h</span><button className="button secondary" onClick={() => void refresh()} disabled={loading}>{loading ? 'Atualizando...' : 'Atualizar'}</button></div></header>
    <div className="trace-metrics"><TraceMetric label="Webhooks" value={summary?.webhook ?? 0} hint="recebidos nas últimas 24h" tone="webhook" /><TraceMetric label="Fila" value={summary?.queue ?? 0} hint="processamentos agendados" tone="queue" /><TraceMetric label="Agente" value={summary?.agent ?? 0} hint="execuções e decisões" tone="agent" /><TraceMetric label="Falhas" value={summary?.failed ?? 0} hint="exigem atenção" tone={summary?.failed ? 'failed' : 'safe'} /></div>
    <div className="trace-toolbar" aria-label="Filtrar trace"><strong>Eventos recentes</strong><div>{(['all', 'webhook', 'queue', 'agent', 'failed'] as const).map((item) => <button key={item} type="button" className={filter === item ? 'selected' : ''} onClick={() => setFilter(item)}>{traceFilterLabel(item)}</button>)}</div></div>
    <section className="trace-list">{!loading && visible.length === 0 ? <Empty title="Nenhum trace neste filtro" text="Os próximos webhooks, execuções e filas aparecerão aqui automaticamente." /> : visible.map((trace) => <article className={`trace-row ${trace.status}`} key={trace.id}><span className={`trace-icon ${trace.event_type.split('.')[0]}`}>{traceIcon(trace.event_type)}</span><div className="trace-copy"><div><strong>{traceEventLabel(trace.event_type)}</strong><span className={`trace-status ${trace.status}`}>{traceStatusLabel(trace.status)}</span></div><p>{traceDetail(trace)}{trace.contact_name || trace.phone_e164 ? ` · ${trace.contact_name ?? trace.phone_e164}` : ''}{trace.channel_name ? ` · ${trace.channel_name}` : ''}</p></div><time>{formatDate(trace.created_at)} · {formatTime(trace.created_at)}</time></article>)}</section>
    {!loading && visible.length > 0 && <TraceExecutionDetail trace={selectedTrace} events={executionEvents} options={visible.slice(0, 10)} onSelect={setSelectedTraceId} />}
  */
}

function TraceExecutionDetail({ trace, events, options, onSelect }: { trace: OperationTrace | null; events: OperationTrace[]; options: OperationTrace[]; onSelect: (id: string) => void }) {
  if (!trace) return null;
  const startedAt = events[0] ? new Date(events[0].created_at).getTime() : new Date(trace.created_at).getTime();
  const completedAt = events.at(-1) ? new Date(events.at(-1)!.created_at).getTime() : startedAt;
  return <section className="trace-detail"><header className="trace-detail-header"><div><p className="eyebrow">Detalhe da execução</p><h2>{trace.contact_name ?? trace.phone_e164 ?? 'Conversa sem identificação'}</h2><p>{trace.channel_name ?? 'Canal não informado'} · {events.length} etapa{events.length === 1 ? '' : 's'} · {formatTraceDuration(completedAt - startedAt)}</p></div><span className={`trace-status ${trace.status}`}>{traceStatusLabel(trace.status)}</span></header><div className="trace-run-picker" aria-label="Selecionar execução">{options.map((option) => <button type="button" className={option.id === trace.id ? 'selected' : ''} key={option.id} onClick={() => onSelect(option.id)}>{traceEventLabel(option.event_type)} · {formatTime(option.created_at)}</button>)}</div><div className="trace-flow" aria-label="Linha do tempo da execução">{events.map((event, index) => <article className={`trace-step ${event.status}`} key={event.id}><span className={`trace-icon ${event.event_type.split('.')[0]}`}>{traceIcon(event.event_type)}</span><div><div className="trace-step-topline"><strong>{traceEventLabel(event.event_type)}</strong><time>{formatTime(event.created_at)}</time></div><p>{traceDetail(event)}</p>{index > 0 && <small>{formatTraceGap(new Date(event.created_at).getTime() - new Date(events[index - 1].created_at).getTime())} após a etapa anterior</small>}</div></article>)}</div><footer className="trace-detail-meta"><span>Execução {trace.agent_run_id ? trace.agent_run_id.slice(0, 8) : 'operacional'}</span><span>Conteúdo e credenciais permanecem ocultos</span></footer></section>;
}

type TraceFilter = 'all' | 'webhook' | 'queue' | 'agent' | 'failed';
type TraceExecution = { id: string; main: OperationTrace; events: OperationTrace[]; status: OperationTrace['status'] };

function TraceExecutionList({ summary, loading, filter, executions, selectedExecution, onRefresh, onFilterChange, onSelect, onClose }: { summary: OperationTraceSummary | null; loading: boolean; filter: TraceFilter; executions: TraceExecution[]; selectedExecution: TraceExecution | null; onRefresh: () => Promise<void>; onFilterChange: (filter: TraceFilter) => void; onSelect: (id: string) => void; onClose: () => void }) {
  return <section className="trace-dashboard">
    <header className="page-header"><div><p className="eyebrow">Observabilidade</p><h1>Trace operacional</h1><p className="page-description">Uma linha por execucao. Abra apenas a que precisa investigar.</p></div><div className="header-actions"><span className="metric"><strong>{summary?.total ?? 0}</strong> eventos · 24h</span><button className="button secondary" onClick={() => void onRefresh()} disabled={loading}>{loading ? 'Atualizando...' : 'Atualizar'}</button></div></header>
    <div className="trace-metrics"><TraceMetric label="Webhooks" value={summary?.webhook ?? 0} hint="recebidos nas ultimas 24h" tone="webhook" /><TraceMetric label="Fila" value={summary?.queue ?? 0} hint="processamentos agendados" tone="queue" /><TraceMetric label="Agente" value={summary?.agent ?? 0} hint="execucoes e decisoes" tone="agent" /><TraceMetric label="Falhas" value={summary?.failed ?? 0} hint="exigem atencao" tone={summary?.failed ? 'failed' : 'safe'} /></div>
    <div className="trace-toolbar" aria-label="Filtrar trace"><strong>Execucoes recentes</strong><div>{(['all', 'webhook', 'queue', 'agent', 'failed'] as const).map((item) => <button key={item} type="button" className={filter === item ? 'selected' : ''} onClick={() => onFilterChange(item)}>{traceFilterLabel(item)}</button>)}</div></div>
    <section className="trace-list">{!loading && executions.length === 0 ? <Empty title="Nenhuma execucao neste filtro" text="Os proximos webhooks e processamentos aparecerao aqui automaticamente." /> : executions.map((execution) => <button type="button" className={`trace-row ${execution.status} ${selectedExecution?.id === execution.id ? 'selected' : ''}`} key={execution.id} onClick={() => onSelect(execution.id)}><span className={`trace-icon ${execution.main.event_type.split('.')[0]}`}>{traceIcon(execution.main.event_type)}</span><span className="trace-copy"><span><strong>{traceEventLabel(execution.main.event_type)}</strong><span className={`trace-status ${execution.status}`}>{traceStatusLabel(execution.status)}</span></span><p>{traceDetail(execution.main)}{execution.main.contact_name || execution.main.phone_e164 ? ` · ${execution.main.contact_name ?? execution.main.phone_e164}` : ''}{execution.main.channel_name ? ` · ${execution.main.channel_name}` : ''}<em>{execution.events.length} etapa{execution.events.length === 1 ? '' : 's'}</em></p></span><time>{formatDate(execution.main.created_at)} · {formatTime(execution.main.created_at)}</time><span className="trace-open" aria-hidden="true">›</span></button>)}</section>
    {selectedExecution && <TraceExecutionPanel execution={selectedExecution} onClose={onClose} />}
  </section>;
}

function TraceExecutionPanel({ execution, onClose }: { execution: TraceExecution; onClose: () => void }) {
  const { main: trace, events, status } = execution;
  const startedAt = new Date(events[0].created_at).getTime();
  const completedAt = new Date(events.at(-1)!.created_at).getTime();
  return <section className="trace-detail"><header className="trace-detail-header"><div><p className="eyebrow">Detalhe da execucao</p><h2>{trace.contact_name ?? trace.phone_e164 ?? 'Conversa sem identificacao'}</h2><p>{trace.channel_name ?? 'Canal nao informado'} · {events.length} etapa{events.length === 1 ? '' : 's'} · {formatTraceDuration(completedAt - startedAt)}</p></div><div className="trace-detail-actions"><span className={`trace-status ${status}`}>{traceStatusLabel(status)}</span><button type="button" className="trace-close" onClick={onClose}>Fechar</button></div></header><div className="trace-flow" aria-label="Linha do tempo da execucao">{events.map((event, index) => <article className={`trace-step ${event.status}`} key={event.id}><span className={`trace-icon ${event.event_type.split('.')[0]}`}>{traceIcon(event.event_type)}</span><div><div className="trace-step-topline"><strong>{traceEventLabel(event.event_type)}</strong><time>{formatTime(event.created_at)}</time></div><p>{traceDetail(event)}</p>{index > 0 && <small>{formatTraceGap(new Date(event.created_at).getTime() - new Date(events[index - 1].created_at).getTime())} apos a etapa anterior</small>}</div></article>)}</div><footer className="trace-detail-meta"><span>Execucao {trace.agent_run_id ? trace.agent_run_id.slice(0, 8) : 'operacional'}</span><span>Conteudo e credenciais permanecem ocultos</span></footer></section>;
}

function buildTraceExecutions(traces: OperationTrace[]): TraceExecution[] {
  const grouped = new Map<string, OperationTrace[]>();
  for (const trace of traces) {
    const key = trace.conversation_id ? `conversation:${trace.conversation_id}` : trace.agent_run_id ? `run:${trace.agent_run_id}` : `event:${trace.id}`;
    grouped.set(key, [...(grouped.get(key) ?? []), trace]);
  }
  const executions: TraceExecution[] = [];
  for (const [key, events] of grouped) {
    const ordered = [...events].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime() || traceEventOrder(a.event_type) - traceEventOrder(b.event_type));
    let current: OperationTrace[] = [];
    for (const event of ordered) {
      if (current.length > 0 && isTraceMainEvent(event)) {
        executions.push(toTraceExecution(key, current));
        current = [];
      }
      current.push(event);
    }
    if (current.length > 0) executions.push(toTraceExecution(key, current));
  }
  return executions.sort((a, b) => new Date(b.main.created_at).getTime() - new Date(a.main.created_at).getTime());
}

function isTraceMainEvent(trace: OperationTrace) { return trace.event_type === 'webhook.received' || trace.event_type === 'webhook.simulated' || trace.event_type === 'webhook.duplicate'; }
function toTraceExecution(key: string, events: OperationTrace[]): TraceExecution { const status = events.some((event) => event.status === 'failed') ? 'failed' : events.at(-1)?.status ?? events[0].status; return { id: `${key}:${events[0].id}`, main: events[0], events, status }; }
function matchesTraceFilter(execution: TraceExecution, filter: TraceFilter) { if (filter === 'all') return true; if (filter === 'failed') return execution.status === 'failed'; return execution.events.some((event) => event.event_type.startsWith(`${filter}.`)); }

function TraceMetric({ label, value, hint, tone }: { label: string; value: number; hint: string; tone: string }) {
  return <article className={`trace-metric ${tone}`}><small>{label}</small><strong>{value}</strong><span>{hint}</span></article>;
}

function ConversationView({ conversation, messages, onError, onChanged, canEditTags }: { conversation: Conversation | null; messages: Message[]; onError: (message: string) => void; onChanged: () => Promise<void>; canEditTags: boolean }) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [salesContext, setSalesContext] = useState<SalesContext | null>(null);
  const [conversationTags, setConversationTags] = useState<ConversationTag[]>([]);
  const [availableTags, setAvailableTags] = useState<ConversationTag[]>([]);
  const [selectedTagSlug, setSelectedTagSlug] = useState('');
  const [updatingTag, setUpdatingTag] = useState(false);
  useEffect(() => {
    if (!conversation) { setSalesContext(null); setConversationTags([]); setAvailableTags([]); return; }
    void Promise.all([api.salesContext(conversation.id), api.conversationTags(conversation.id), api.tags('conversation')])
      .then(([context, tags, tagCatalog]) => { setSalesContext(context); setConversationTags(tags.data); setAvailableTags(tagCatalog.data); setSelectedTagSlug(''); })
      .catch((reason) => onError(reason instanceof Error ? reason.message : 'Não foi possível carregar o contexto comercial.'));
  }, [conversation?.id]);
  if (!conversation) return <section className="conversation-empty"><Empty title="Selecione uma conversa" text="O histórico e as ações do atendimento aparecerão neste espaço." /></section>;
  const activeConversation = conversation;
  async function send(event: FormEvent) {
    event.preventDefault(); if (!draft.trim()) return;
    setSending(true);
    try { await api.sendMessage(activeConversation.id, draft.trim()); setDraft(''); await onChanged(); }
    catch (reason) { onError(reason instanceof Error ? reason.message : 'Não foi possível colocar a mensagem na fila.'); }
    finally { setSending(false); }
  }
  async function toggleHandoff() {
    try { if (activeConversation.status === 'waiting_human') await api.resume(activeConversation.id); else await api.handoff(activeConversation.id, 'Assumido pelo atendimento humano'); await onChanged(); }
    catch (reason) { onError(reason instanceof Error ? reason.message : 'Não foi possível atualizar o atendimento.'); }
  }
  async function addTag() {
    if (!selectedTagSlug) return;
    setUpdatingTag(true);
    try {
      await api.assignConversationTag(activeConversation.id, selectedTagSlug);
      const tag = availableTags.find((item) => item.slug === selectedTagSlug);
      if (tag) setConversationTags((current) => [...current.filter((item) => item.slug !== tag.slug), { ...tag, source: 'manual' }]);
      setSelectedTagSlug('');
    } catch (reason) { onError(reason instanceof Error ? reason.message : 'Não foi possível aplicar a tag.'); }
    finally { setUpdatingTag(false); }
  }
  async function removeTag(tag: ConversationTag) {
    setUpdatingTag(true);
    try { await api.removeConversationTag(activeConversation.id, tag.slug); setConversationTags((current) => current.filter((item) => item.slug !== tag.slug)); }
    catch (reason) { onError(reason instanceof Error ? reason.message : 'Não foi possível remover a tag.'); }
    finally { setUpdatingTag(false); }
  }
  return <section className="conversation-workspace"><section className="conversation-panel"><header className="conversation-header"><div><p className="eyebrow">{activeConversation.channel_name}</p><h2>{activeConversation.contact_name ?? activeConversation.phone_e164 ?? 'Contato'}</h2></div><button className="button secondary" onClick={() => void toggleHandoff()}>{activeConversation.status === 'waiting_human' ? 'Retomar agente' : 'Assumir atendimento'}</button></header>
    <div className="message-area">{messages.length === 0 ? <Empty title="Sem mensagens para exibir" text="O histórico será carregado assim que houver interação." /> : messages.map((message) => <article key={message.id} className={`bubble ${message.direction}`}><p>{message.body ?? `[${message.type}]`}</p><small>{formatTime(message.created_at)} {message.direction === 'outbound' && `· ${message.delivery_status}`}</small></article>)}</div>
    <form className="composer" onSubmit={send}><textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Escreva uma resposta…" rows={2} /><button className="button primary" disabled={sending}>{sending ? 'Enviando…' : 'Enviar'}</button></form></section>
    <aside className="sales-sidebar"><div className="sales-sidebar-head"><p className="eyebrow">Leitura comercial</p><h3>{stageLabel(salesContext?.stage)}</h3><span className={`intent-pill ${salesContext?.intent ?? 'unknown'}`}>{intentLabel(salesContext?.intent)}</span></div><section className="sales-block"><div className="sales-block-head"><strong>Tags</strong><span>{conversationTags.length}</span></div>{conversationTags.length ? <div className="tag-list">{conversationTags.map((tag) => <span className="tag" key={tag.id} title={`Origem: ${tag.source ?? 'manual'}`}>{tag.name}{canEditTags && tag.source === 'manual' && <button type="button" onClick={() => void removeTag(tag)} disabled={updatingTag} aria-label={`Remover tag ${tag.name}`}>×</button>}</span>)}</div> : <p className="muted">Nenhuma tag nesta conversa.</p>}{canEditTags && <div className="tag-adder"><select value={selectedTagSlug} onChange={(event) => setSelectedTagSlug(event.target.value)} aria-label="Adicionar tag à conversa"><option value="">Adicionar tag...</option>{availableTags.filter((tag) => !conversationTags.some((current) => current.slug === tag.slug)).map((tag) => <option key={tag.id} value={tag.slug}>{tag.name}</option>)}</select><button type="button" className="text-button" onClick={() => void addTag()} disabled={!selectedTagSlug || updatingTag}>{updatingTag ? 'Salvando...' : 'Aplicar'}</button></div>}</section><section className="sales-block"><strong>Fatos confirmados</strong>{salesContext && Object.keys(salesContext.facts).length ? <dl className="facts-list">{Object.entries(salesContext.facts).map(([key, value]) => <div key={key}><dt>{factLabel(key)}</dt><dd>{Array.isArray(value) ? value.join(', ') : String(value)}</dd></div>)}</dl> : <p className="muted">O agente registra aqui somente informações comerciais confirmadas.</p>}</section><section className="sales-tip"><strong>Próxima boa ação</strong><p>{nextAction(salesContext?.stage, activeConversation.status)}</p></section></aside></section>;
}

function Catalog({ user, onError }: { user: PanelUser; onError: (message: string) => void }) {
  const [products, setProducts] = useState<Product[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Product | null | undefined>(undefined);
  const canEdit = user.role === 'owner' || user.role === 'admin';
  const load = async (searchQuery = query) => { setLoading(true); try { setProducts((await api.products(searchQuery)).data); } catch (reason) { onError(reason instanceof Error ? reason.message : 'Não foi possível carregar o catálogo.'); } finally { setLoading(false); } };
  useEffect(() => { void load(''); }, []);
  async function search(event: FormEvent) { event.preventDefault(); await load(query); }
  function saved(product: Product) { setProducts((current) => current.some((item) => item.id === product.id) ? current.map((item) => item.id === product.id ? product : item) : [product, ...current]); setEditing(product); }
  return <section><header className="page-header"><div><p className="eyebrow">Base de produtos</p><h1>Catálogo</h1></div><div className="header-actions"><span className="metric"><strong>{products.length}</strong> itens</span>{canEdit && <button className="button primary" onClick={() => setEditing(null)}>Novo produto</button>}</div></header>
    <form className="catalog-toolbar" onSubmit={search}><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar por nome, categoria ou descrição" /><button className="button secondary">Buscar</button></form>
    {!loading && products.length === 0 ? <div className="empty-page"><Empty title="Seu catálogo está vazio" text="Cadastre produtos e vincule as fotos que o agente poderá enviar ao cliente." /></div> : <div className="product-grid">{products.map((product) => <article className="product-card" key={product.id}><div className="product-image">{product.media[0]?.url ? <img src={product.media[0].url} alt={product.media[0].altText ?? product.name} /> : <span>▧</span>}</div><div><div className="product-topline"><small>{product.category ?? 'Sem categoria'}</small><span className={product.available ? 'availability available' : 'availability'}>{product.available ? 'Disponível' : 'Indisponível'}</span></div><h2>{product.name}</h2><p>{product.description ?? 'Sem descrição cadastrada.'}</p><footer><strong>{formatPrice(product.price_cents, product.currency)}</strong><span><small>{product.sku}</small>{canEdit && <button className="text-button" onClick={() => setEditing(product)}>Editar</button>}</span></footer></div></article>)}</div>}
    {editing !== undefined && <ProductEditor key={editing?.id ?? 'new'} product={editing} onClose={() => setEditing(undefined)} onSaved={saved} onRefresh={() => load(query)} onError={onError} />}
  </section>;
}

function ProductEditor({ product, onClose, onSaved, onRefresh, onError }: { product: Product | null; onClose: () => void; onSaved: (product: Product) => void; onRefresh: () => Promise<void>; onError: (message: string) => void }) {
  const [sku, setSku] = useState(product?.sku ?? '');
  const [name, setName] = useState(product?.name ?? '');
  const [category, setCategory] = useState(product?.category ?? '');
  const [description, setDescription] = useState(product?.description ?? '');
  const [tags, setTags] = useState(product?.tags.join(', ') ?? '');
  const [price, setPrice] = useState(product?.price_cents === null || product?.price_cents === undefined ? '' : (product.price_cents / 100).toFixed(2).replace('.', ','));
  const [available, setAvailable] = useState(product?.available ?? true);
  const [saving, setSaving] = useState(false);
  const [mediaUrl, setMediaUrl] = useState('');
  const [mediaAlt, setMediaAlt] = useState('');
  const [addingMedia, setAddingMedia] = useState(false);
  const [mediaFile, setMediaFile] = useState<File | null>(null);
  const save = async (event: FormEvent) => {
    event.preventDefault(); setSaving(true);
    const normalizedPrice = price.trim() ? Math.round(Number(price.includes(',') ? price.replace(/\./g, '').replace(',', '.') : price) * 100) : undefined;
    const input: ProductInput = { sku, name, category: category || undefined, description: description || undefined, tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean), priceCents: normalizedPrice, currency: 'BRL', available };
    try {
      const result = product ? await api.updateProduct(product.id, input) : await api.createProduct(input);
      onSaved({ ...result, media: product?.media ?? [] });
    } catch (reason) { onError(reason instanceof Error ? reason.message : 'Não foi possível salvar o produto.'); }
    finally { setSaving(false); }
  };
  const addMedia = async (event: FormEvent) => {
    event.preventDefault(); if (!product || !mediaUrl) return;
    setAddingMedia(true);
    try { await api.addProductMedia(product.id, { storageKey: `external/${product.id}/${crypto.randomUUID()}`, publicUrl: mediaUrl, mimeType: 'image/jpeg', altText: mediaAlt || name, position: product.media.length }); await onRefresh(); setMediaUrl(''); setMediaAlt(''); }
    catch (reason) { onError(reason instanceof Error ? reason.message : 'Não foi possível vincular a imagem.'); }
    finally { setAddingMedia(false); }
  };
  const uploadMedia = async () => {
    if (!product || !mediaFile) return;
    setAddingMedia(true);
    try {
      const intent = await api.createProductMediaUpload(product.id, { filename: mediaFile.name, mimeType: mediaFile.type, byteSize: mediaFile.size, altText: mediaAlt || name, position: product.media.length });
      const response = await fetch(intent.uploadUrl, { method: 'PUT', headers: intent.headers, body: mediaFile });
      if (!response.ok) throw new Error('Não foi possível enviar o arquivo para o armazenamento.');
      await api.completeProductMediaUpload(product.id, intent.assetId);
      await onRefresh(); setMediaFile(null); setMediaAlt('');
    } catch (reason) { onError(reason instanceof Error ? reason.message : 'Não foi possível enviar a foto.'); }
    finally { setAddingMedia(false); }
  };
  return <div className="modal-backdrop" role="presentation"><section className="product-editor" role="dialog" aria-modal="true" aria-label={product ? 'Editar produto' : 'Novo produto'}><header><div><p className="eyebrow">{product ? 'Catálogo' : 'Novo item'}</p><h2>{product ? `Editar ${product.name}` : 'Cadastrar produto'}</h2></div><button className="icon-button editor-close" onClick={onClose} aria-label="Fechar">×</button></header><form className="product-form" onSubmit={save}><div className="form-grid"><label>SKU<input value={sku} onChange={(event) => setSku(event.target.value)} required /></label><label>Categoria<input value={category} onChange={(event) => setCategory(event.target.value)} placeholder="Ex.: Bolsas" /></label></div><label>Nome do produto<input value={name} onChange={(event) => setName(event.target.value)} required /></label><label>Descrição<textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} placeholder="Características, contexto e diferenciais." /></label><div className="form-grid"><label>Preço (R$)<input value={price} onChange={(event) => setPrice(event.target.value)} inputMode="decimal" placeholder="189,90" /></label><label>Tags<input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="gestação, rosa, personalizada" /></label></div><label className="check-field"><input checked={available} onChange={(event) => setAvailable(event.target.checked)} type="checkbox" /> Produto disponível para atendimento</label><footer><button type="button" className="button secondary" onClick={onClose}>Cancelar</button><button className="button primary" disabled={saving}>{saving ? 'Salvando…' : 'Salvar produto'}</button></footer></form>{product && <section className="media-editor"><div><p className="eyebrow">Fotos e arquivos</p><h3>Mídias vinculadas</h3></div>{product.media.length ? <div className="media-strip">{product.media.map((media) => media.url ? <img key={media.id} src={media.url} alt={media.altText ?? product.name} /> : <span className="media-pending" key={media.id}>Processando</span>)}</div> : <p className="muted">Ainda não há fotos vinculadas.</p>}<div className="upload-row"><input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => setMediaFile(event.target.files?.[0] ?? null)} /><input value={mediaAlt} onChange={(event) => setMediaAlt(event.target.value)} placeholder="Descrição da foto" /><button type="button" className="button primary" disabled={!mediaFile || addingMedia} onClick={() => void uploadMedia()}>{addingMedia ? 'Enviando…' : 'Enviar foto'}</button></div><form className="media-form" onSubmit={addMedia}><input type="url" value={mediaUrl} onChange={(event) => setMediaUrl(event.target.value)} placeholder="Ou vincule uma URL HTTPS" required /><button className="button secondary" disabled={addingMedia}>{addingMedia ? 'Vinculando…' : 'Vincular URL'}</button></form></section>}</section></div>;
}

type AgentRulesTab = 'strategy' | 'rules' | 'playbook';

function AgentRulesCenter({ user, onError }: { user: PanelUser; onError: (message: string) => void }) {
  const [playbook, setPlaybook] = useState<AgentPlaybook | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<AgentRulesTab>('strategy');
  const canManage = user.role === 'owner' || user.role === 'admin';
  useEffect(() => {
    if (!canManage) { setLoading(false); return; }
    api.playbook().then(setPlaybook).catch((reason) => onError(reason instanceof Error ? reason.message : 'Não foi possível carregar o playbook.')).finally(() => setLoading(false));
  }, [canManage]);
  return <section className="agent-rules-center">
    <header className="agent-rules-header"><div><p className="eyebrow">Atendimento inteligente</p><h1>Agente e regras</h1><p className="page-description">Defina como a IA conduz a venda, quando consulta dados reais e em quais situações a equipe humana assume.</p></div><div className="agent-rules-status"><span className={`pill ${playbook ? 'success' : 'warning'}`}>{loading ? 'Carregando' : playbook ? `Playbook v${playbook.version} ativo` : 'Playbook pendente'}</span><span className="agent-rules-status-copy">{playbook ? 'Regras protegidas' : 'Revise as configurações'}</span></div></header>
    <nav className="agent-rules-tabs" aria-label="Áreas de agente e regras"><button type="button" className={activeTab === 'strategy' ? 'active' : ''} onClick={() => setActiveTab('strategy')}><span>01</span> Estratégia de atendimento</button><button type="button" className={activeTab === 'rules' ? 'active' : ''} onClick={() => setActiveTab('rules')}><span>02</span> Tags e roteamento</button><button type="button" className={activeTab === 'playbook' ? 'active' : ''} onClick={() => setActiveTab('playbook')}><span>03</span> Playbook ativo</button></nav>
    {activeTab === 'strategy' && <Automation playbook={playbook} onOpenRules={() => setActiveTab('rules')} />}
    {activeTab === 'rules' && <RulesManager user={user} onError={onError} />}
    {activeTab === 'playbook' && <PlaybookInspector playbook={playbook} loading={loading} />}
  </section>;
}

const journeyStages = [
  { number: '01', title: 'Descobrir o contexto', agent: 'Atendimento', goal: 'Entender o momento, o perfil e a necessidade antes de sugerir qualquer produto.', tools: ['Histórico da conversa', 'Tags do contato'], outcome: 'Pergunta aberta e contexto registrado.' },
  { number: '02', title: 'Mapear necessidade', agent: 'Atendimento + Suporte', goal: 'Aprofundar dor, urgência e cenário ideal; dúvidas específicas podem chamar o especialista de suporte.', tools: ['Base de suporte', 'Handoff interno'], outcome: 'Intenção e objeções identificadas.' },
  { number: '03', title: 'Recomendar produto real', agent: 'Produtos', goal: 'Consultar somente dados do catálogo interno para apresentar opção, preço, estoque e mídia.', tools: ['Catálogo interno', 'Estoque', 'Fotos do produto'], outcome: 'Até três opções relevantes e verificáveis.' },
  { number: '04', title: 'Transferir com contexto', agent: 'Equipe humana', goal: 'Encerrar a automação quando existir intenção de compra, pagamento, pedido ou uma situação sensível.', tools: ['Tag de handoff', 'Resumo da conversa'], outcome: 'Atendimento humano recebe o próximo passo.' }
];

function Automation({ playbook, onOpenRules }: { playbook: AgentPlaybook | null; onOpenRules: () => void }) {
  const [selectedStage, setSelectedStage] = useState(0);
  const stage = journeyStages[selectedStage];
  return <div className="agent-rules-content">
    <div className="automation-overview"><article className="automation-primary"><div><p className="eyebrow">Estratégia ativa</p><h2>Vender com contexto, não com pressão</h2><p>O agente escuta, valida a necessidade e só recomenda produtos com dados reais. A finalização é sempre protegida por handoff humano.</p></div><div className="playbook-meta"><strong>v{playbook?.version ?? '—'}</strong><span>{playbook ? 'Versionado e auditável' : 'Aguardando playbook'}</span></div></article><article className="automation-stat"><strong>4</strong><span>etapas guiadas</span></article><article className="automation-stat"><strong>3</strong><span>especialistas em cooperação</span></article></div>
    <section className="strategy-workspace"><div className="strategy-stage-list" aria-label="Etapas do atendimento"><div className="strategy-stage-heading"><div><p className="eyebrow">Fluxo de atendimento</p><h2>Jornada guiada</h2></div><span>Selecione uma etapa</span></div>{journeyStages.map((item, index) => <button key={item.number} type="button" className={selectedStage === index ? 'selected' : ''} onClick={() => setSelectedStage(index)}><span>{item.number}</span><div><strong>{item.title}</strong><small>{item.agent}</small></div><i>›</i></button>)}</div><article className="strategy-stage-detail"><div className="stage-detail-head"><span>Etapa {stage.number}</span><p>{stage.agent}</p></div><h3>{stage.title}</h3><p>{stage.goal}</p><div className="stage-tool-group"><strong>Recursos usados</strong><div>{stage.tools.map((tool) => <span key={tool}>{tool}</span>)}</div></div><div className="stage-outcome"><span>Saída esperada</span><strong>{stage.outcome}</strong></div></article><aside className="strategy-guardrails"><div><p className="eyebrow">Proteções</p><h2>Limites que não mudam</h2></div><ul><li>Não inventa preço, promoção, frete ou prazo.</li><li>Não coleta CPF, endereço, cartão ou pagamento.</li><li>Não conduz pedidos, devoluções, atacado ou parcerias.</li><li>Transfere acolhimento e situações delicadas.</li></ul><button className="button secondary" type="button" onClick={onOpenRules}>Configurar regras de entrada</button></aside></section>
  </div>;
}

function PlaybookInspector({ playbook, loading }: { playbook: AgentPlaybook | null; loading: boolean }) {
  if (loading) return <div className="agent-rules-loading">Carregando playbook ativo…</div>;
  if (!playbook) return <Empty title="Playbook ainda não disponível" text="Conclua a configuração inicial para consultar as instruções que orientarão os agentes." />;
  return <section className="playbook-inspector"><header><div><p className="eyebrow">Fonte de comportamento</p><h2>{playbook.name}</h2><p>Versão {playbook.version} · checksum {playbook.checksum.slice(0, 12)} · aplicada a novas conversas.</p></div><span className="prompt-status active">Ativo</span></header><pre>{playbook.instructions}</pre></section>;
}

function RulesManager({ user, onError }: { user: PanelUser; onError: (message: string) => void }) {
  const [tags, setTags] = useState<ConversationTag[]>([]);
  const [policies, setPolicies] = useState<RoutingPolicy[]>([]);
  const [loading, setLoading] = useState(true);
  const [tagName, setTagName] = useState('');
  const [tagSlug, setTagSlug] = useState('');
  const [savingTag, setSavingTag] = useState(false);
  const [ruleName, setRuleName] = useState('');
  const [ruleTags, setRuleTags] = useState<string[]>([]);
  const [ruleAction, setRuleAction] = useState<'handoff' | 'pause_automation'>('handoff');
  const [ruleReason, setRuleReason] = useState('Revisão necessária pela equipe');
  const [addTag, setAddTag] = useState('');
  const [savingRule, setSavingRule] = useState(false);
  const canManage = user.role === 'owner' || user.role === 'admin';
  const load = async () => {
    if (!canManage) { setLoading(false); return; }
    setLoading(true);
    try {
      const [currentTags, currentPolicies] = await Promise.all([api.tags('conversation'), api.routingPolicies()]);
      setTags(currentTags.data); setPolicies(currentPolicies.data);
    } catch (reason) { onError(reason instanceof Error ? reason.message : 'Não foi possível carregar as regras.'); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, [canManage]);
  async function createConversationTag(event: FormEvent) {
    event.preventDefault(); const slug = tagSlug || slugify(tagName); if (!tagName.trim() || !slug) return;
    setSavingTag(true);
    try { const tag = await api.createTag({ scope: 'conversation', name: tagName.trim(), slug }); setTags((current) => [...current, tag].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))); setTagName(''); setTagSlug(''); }
    catch (reason) { onError(reason instanceof Error ? reason.message : 'Não foi possível criar a tag.'); }
    finally { setSavingTag(false); }
  }
  async function createRule(event: FormEvent) {
    event.preventDefault(); if (!ruleName.trim() || !ruleTags.length || !ruleReason.trim()) return;
    setSavingRule(true);
    try {
      const policy = await api.createRoutingPolicy({ name: ruleName.trim(), priority: 100, enabled: true, conditions: { hasTagsAny: ruleTags }, action: { type: ruleAction, reason: ruleReason.trim(), addConversationTags: addTag ? [addTag] : [] } });
      setPolicies((current) => [...current, policy].sort((a, b) => a.priority - b.priority)); setRuleName(''); setRuleTags([]); setAddTag('');
    } catch (reason) { onError(reason instanceof Error ? reason.message : 'Não foi possível criar a regra.'); }
    finally { setSavingRule(false); }
  }
  function toggleRuleTag(slug: string) { setRuleTags((current) => current.includes(slug) ? current.filter((item) => item !== slug) : [...current, slug]); }
  if (!canManage) return null;
  return <section className="rules-manager"><header className="rules-manager-head"><div><p className="eyebrow">Controle operacional</p><h2>Tags e roteamento</h2><p>Tags classificam a conversa. Regras usam essas tags para interromper ou transferir o atendimento com segurança.</p></div><button className="button secondary" onClick={() => void load()} disabled={loading}>Atualizar</button></header><div className="rules-grid"><article className="rules-card"><div className="card-title"><div><h3>Tags de conversa</h3><p>Filtros usados pela equipe, integrações e agente.</p></div><span>{tags.length}</span></div>{tags.length ? <div className="tag-catalog">{tags.map((tag) => <span className="managed-tag" key={tag.id} style={tag.color ? { borderColor: tag.color, color: tag.color } : undefined}>{tag.name}<small>#{tag.slug}</small></span>)}</div> : <p className="empty-inline">Crie a primeira tag para montar as regras de entrada.</p>}<form className="tag-creator" onSubmit={createConversationTag}><input value={tagName} onChange={(event) => { const value = event.target.value; setTagName(value); if (!tagSlug) setTagSlug(slugify(value)); }} placeholder="Ex.: Prioridade humana" aria-label="Nome da tag" /><input value={tagSlug} onChange={(event) => setTagSlug(slugify(event.target.value))} placeholder="prioridade-humana" aria-label="Identificador da tag" /><button className="button secondary" disabled={savingTag || !tagName.trim()}>{savingTag ? 'Criando...' : 'Criar tag'}</button></form></article><article className="rules-card"><div className="card-title"><div><h3>Regras ativas</h3><p>Executadas por prioridade assim que a mensagem entra.</p></div><span>{policies.length}</span></div>{policies.length ? <div className="policy-list">{policies.map((policy) => <div className="policy-row" key={policy.id}><div><strong>{policy.name}</strong><p>{policySummary(policy)}</p></div><span className={`policy-action ${policy.action.type}`}>{policyActionLabel(policy.action.type)}</span></div>)}</div> : <p className="empty-inline">Nenhuma regra adicional. O playbook e as proteções padrão continuam ativos.</p>}</article></div><form className="rule-creator" onSubmit={createRule}><div><p className="eyebrow">Nova regra de segurança</p><h3>Quando a conversa tiver uma destas tags...</h3><p className="muted">A regra só será criada se houver um filtro; isso evita pausar toda a operação por engano.</p></div><div className="rule-fields"><label>Nome da regra<input value={ruleName} onChange={(event) => setRuleName(event.target.value)} placeholder="Ex.: Prioridade para equipe" required /></label><fieldset><legend>Tags que disparam a regra</legend><div className="tag-checkboxes">{tags.length ? tags.map((tag) => <label className="tag-option" key={tag.id}><input type="checkbox" checked={ruleTags.includes(tag.slug)} onChange={() => toggleRuleTag(tag.slug)} />{tag.name}</label>) : <span className="muted">Crie uma tag acima para habilitar este filtro.</span>}</div></fieldset><div className="form-grid"><label>Ação<select value={ruleAction} onChange={(event) => setRuleAction(event.target.value as 'handoff' | 'pause_automation')}><option value="handoff">Transferir para equipe</option><option value="pause_automation">Pausar automação</option></select></label><label>Tag adicional (opcional)<select value={addTag} onChange={(event) => setAddTag(event.target.value)}><option value="">Não adicionar tag</option>{tags.map((tag) => <option key={tag.id} value={tag.slug}>{tag.name}</option>)}</select></label></div><label>Motivo registrado no histórico<input value={ruleReason} onChange={(event) => setRuleReason(event.target.value)} required /></label></div><button className="button primary" disabled={savingRule || !tags.length || !ruleTags.length}>{savingRule ? 'Criando...' : 'Ativar regra'}</button></form></section>;
}

function stageLabel(stage?: string) { return ({ discovery: 'Em descoberta', context: 'Entendendo contexto', pain: 'Mapeando necessidade', consequence: 'Explorando impacto', ideal: 'Cenário ideal', recommendation: 'Recomendação', choice: 'Escolha em andamento', pricing: 'Apresentando preço', freight: 'Frete e prazo', checkout: 'Pronto para equipe', after_sales: 'Pós-venda', human: 'Atendimento humano', sensitive: 'Situação delicada' } as Record<string, string>)[stage ?? ''] ?? 'Nova conversa'; }
function intentLabel(intent?: string) { return ({ product_discovery: 'Produto', price: 'Preço', discount: 'Objeção de valor', freight: 'Frete', checkout: 'Compra', payment: 'Pagamento', order_status: 'Pedido', after_sales: 'Pós-venda', partnership: 'Parceria', wholesale: 'Atacado', sensitive_loss: 'Acolhimento' } as Record<string, string>)[intent ?? ''] ?? 'Em análise'; }
function factLabel(key: string) { return key.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ').replace(/^./, (value) => value.toUpperCase()); }
function nextAction(stage: string | undefined, status: Conversation['status']) { if (status === 'waiting_human') return 'A conversa está com a equipe. Leia o histórico e responda com a próxima ação combinada.'; if (stage === 'pricing') return 'Confirme a reação da cliente e deixe espaço para ela decidir.'; if (stage === 'recommendation') return 'Apresente no máximo três opções e destaque o benefício mais relevante.'; return 'Faça uma pergunta aberta para entender o momento e a necessidade da cliente.'; }

type IntegrationKey = 'home' | 'bling' | 'chatai' | 'agents';

function IntegrationHub({ user, onError }: { user: PanelUser; onError: (message: string) => void }) {
  const [selected, setSelected] = useState<IntegrationKey>('home');
  const canManage = user.role === 'owner' || user.role === 'admin';
  if (selected !== 'home') {
    const copy = ({ bling: ['Bling', 'Catálogo, estoque e pedidos'], chatai: ['Canal de mensagens', 'Recebimento e envio pelo ChatAI'], agents: ['Agentes de IA', 'Modelos, chave e testes de prompt'] } as Record<Exclude<IntegrationKey, 'home'>, [string, string]>)[selected];
    return <section className={`integration-detail ${selected}`}><header className="integration-detail-header"><button className="back-button" type="button" onClick={() => setSelected('home')}>← Todas as integrações</button><div><p className="eyebrow">Configuração</p><h1>{copy[0]}</h1><p>{copy[1]}</p></div></header>{selected === 'bling' && <BlingIntegration user={user} onError={onError} />}{selected === 'chatai' && <ChannelIntegration user={user} onError={onError} />}{selected === 'agents' && <Integrations user={user} onError={onError} />}</section>;
  }
  return <section className="integration-hub"><header className="page-header"><div><p className="eyebrow">Conectores</p><h1>Integrações</h1><p className="page-description">Escolha uma integração para conectar e configurar cada parte da operação.</p></div></header><div className="integration-picker" aria-label="Integrações disponíveis"><button className="integration-choice" type="button" onClick={() => setSelected('chatai')} disabled={!canManage}><span className="integration-icon channel-icon">◒</span><span className="integration-choice-copy"><strong>Canal de mensagens</strong><small>ChatAI, webhook, entrada e envio de mensagens.</small></span><span className="choice-action">Configurar →</span></button><button className="integration-choice" type="button" onClick={() => setSelected('bling')} disabled={!canManage}><span className="integration-icon bling-icon">B</span><span className="integration-choice-copy"><strong>Bling</strong><small>Catálogo interno, estoque, OAuth e sincronização.</small></span><span className="choice-action">Configurar →</span></button><button className="integration-choice" type="button" onClick={() => setSelected('agents')} disabled={!canManage}><span className="integration-icon agent-choice-icon">✦</span><span className="integration-choice-copy"><strong>Agentes de IA</strong><small>Chave OpenAI, modelos, especialistas e teste de prompt.</small></span><span className="choice-action">Configurar →</span></button></div>{!canManage && <div className="empty-page"><Empty title="Acesso restrito" text="Somente owner e admin podem configurar integrações." /></div>}</section>;
}

function BlingIntegration({ user, onError }: { user: PanelUser; onError: (message: string) => void }) {
  const [connection, setConnection] = useState<BlingConnectionStatus | null>(null);
  const [syncRuns, setSyncRuns] = useState<BlingCatalogSyncRun[]>([]);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [syncMode, setSyncMode] = useState<'incremental' | 'full'>('incremental');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [authorizing, setAuthorizing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const canManage = user.role === 'owner' || user.role === 'admin';

  const load = async () => {
    if (!canManage) { setLoading(false); return; }
    setLoading(true);
    try {
      const [currentConnection, currentRuns] = await Promise.all([api.blingConnection(), api.blingCatalogSyncRuns()]);
      setConnection(currentConnection); setSyncRuns(currentRuns.data);
    } catch (reason) { onError(reason instanceof Error ? reason.message : 'Não foi possível carregar a integração do Bling.'); }
    finally { setLoading(false); }
  };

  useEffect(() => { void load(); }, [canManage]);

  async function saveConnection(event: FormEvent) {
    event.preventDefault(); if (!clientId.trim() || !clientSecret.trim()) return;
    setSaving(true);
    try {
      setConnection(await api.saveBlingConnection(clientId.trim(), clientSecret.trim()));
      setClientSecret('');
    } catch (reason) { onError(reason instanceof Error ? reason.message : 'Não foi possível salvar a conexão do Bling.'); }
    finally { setSaving(false); }
  }

  async function authorize() {
    setAuthorizing(true);
    try {
      const result = await api.beginBlingAuthorization();
      window.location.assign(result.authorizationUrl);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : 'Não foi possível iniciar a autorização do Bling.');
      setAuthorizing(false);
    }
  }

  async function requestSync() {
    setSyncing(true);
    try {
      await api.requestBlingCatalogSync(syncMode);
      await load();
    } catch (reason) { onError(reason instanceof Error ? reason.message : 'Não foi possível solicitar a sincronização.'); }
    finally { setSyncing(false); }
  }
  async function copyRedirectUri() {
    if (!connection?.redirectUri) return;
    try { await navigator.clipboard.writeText(connection.redirectUri); }
    catch { onError('Não foi possível copiar a URL. Selecione e copie manualmente.'); }
  }

  const isActive = connection?.status === 'active';
  if (!canManage) return null;
  return <section className="bling-integration"><header className="bling-header"><div className="integration-brand"><span className="integration-icon bling-icon">B</span><div><p className="eyebrow">Catálogo e operação</p><h2>Bling</h2><p>Produtos, estoque e consulta de pedidos ficam centralizados no seu banco interno.</p></div></div><div className="bling-header-actions"><span className={`pill ${blingStatusTone(connection?.status)}`}>{loading ? 'Carregando' : blingStatusLabel(connection?.status)}</span><button className="button secondary" type="button" onClick={() => void load()} disabled={loading}>Atualizar</button></div></header>
    <div className="bling-body">
      {connection?.status === 'not_configured' || !connection ? <form className="bling-credentials" onSubmit={saveConnection}><div><h3>1. Cadastrar aplicativo</h3><p>Informe as credenciais do aplicativo criado no Bling. O segredo é enviado uma vez, cifrado no backend e nunca volta para o painel.</p></div>{connection?.redirectUri && <div className="bling-redirect-guide"><strong>Antes de salvar: cadastre esta URL de redirecionamento no aplicativo do Bling</strong><div><code>{connection.redirectUri}</code><button className="button secondary" type="button" onClick={() => void copyRedirectUri()}>Copiar URL</button></div><small>Ela precisa coincidir exatamente com a URL cadastrada no Bling para concluir o OAuth.</small></div>}<div className="form-grid"><label>Client ID<input value={clientId} onChange={(event) => setClientId(event.target.value)} autoComplete="off" placeholder="Identificador do aplicativo" required /></label><label>Client Secret<input type="password" value={clientSecret} onChange={(event) => setClientSecret(event.target.value)} autoComplete="new-password" placeholder="Cole somente quando for conectar" required /></label></div><button className="button primary" disabled={saving || !clientId.trim() || !clientSecret.trim()}>{saving ? 'Salvando...' : 'Salvar conexão'}</button></form> : <section className="bling-connection-state"><div><p className="eyebrow">Conexão registrada</p><h3>{connection.clientIdHint ?? 'Aplicativo Bling'}</h3><p>{connection.status === 'active' ? 'OAuth concluído. Os tokens ficam protegidos no backend.' : 'Credenciais salvas. Falta autorizar o acesso à conta Bling.'}</p></div>{connection.status === 'active' ? <span className="connection-ok">Conectado</span> : <button className="button primary" type="button" onClick={() => void authorize()} disabled={authorizing}>{authorizing ? 'Abrindo Bling...' : '2. Conectar ao Bling'}</button>}</section>}
      <section className="bling-sync-panel"><header><div><p className="eyebrow">Sincronização de catálogo</p><h3>Atualizar base interna</h3><p>O agente consulta sempre a base interna; o Bling alimenta essa base por fila, sem travar o atendimento.</p></div></header><div className="bling-sync-controls"><label>Modo<select value={syncMode} onChange={(event) => setSyncMode(event.target.value as 'incremental' | 'full')} disabled={!isActive || syncing}><option value="incremental">Incremental — somente alterações</option><option value="full">Completa — revisar todo o catálogo</option></select></label><button className="button primary" type="button" onClick={() => void requestSync()} disabled={!isActive || syncing}>{syncing ? 'Solicitando...' : 'Solicitar sincronização'}</button></div>{!isActive && <p className="integration-hint">Conclua o OAuth para liberar a sincronização. Nenhum produto é buscado antes disso.</p>}<p className="integration-hint">A interface, a fila e o histórico já estão prontos. A leitura real de produtos do Bling será ativada na próxima etapa do adaptador de catálogo.</p></section>
      <section className="sync-history"><header><div><p className="eyebrow">Histórico</p><h3>Últimas sincronizações</h3></div><span>{syncRuns.length}</span></header>{syncRuns.length ? <div className="sync-run-list">{syncRuns.map((run) => <article className="sync-run" key={run.id}><div><strong>{run.mode === 'full' ? 'Completa' : 'Incremental'}</strong><small>{formatDate(run.created_at)} · {blingSyncStatusLabel(run.status)}</small></div><div className="sync-run-metrics"><span>{run.products_upserted} atualizados</span><span>{run.products_deactivated} indisponíveis</span></div>{run.error_code && <p>{blingSyncError(run.error_code)}</p>}</article>)}</div> : <p className="empty-inline">Ainda não há sincronizações solicitadas para esta organização.</p>}</section>
    </div>
  </section>;
}

function LegacyChannelIntegration({ user, onError }: { user: PanelUser; onError: (message: string) => void }) {
  const [channels, setChannels] = useState<MessageChannel[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [newName, setNewName] = useState('WhatsApp principal');
  const [newExternalId, setNewExternalId] = useState('');
  const [backendUrl, setBackendUrl] = useState('');
  const [apiToken, setApiToken] = useState('');
  const [queueId, setQueueId] = useState('0');
  const [webhook, setWebhook] = useState<ChatAiConnectionResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const canManage = user.role === 'owner' || user.role === 'admin';

  const load = async () => {
    if (!canManage) { setLoading(false); return; }
    setLoading(true);
    try {
      const result = await api.channels();
      setChannels(result.data);
      setSelectedId((current) => current && result.data.some((channel) => channel.id === current) ? current : (result.data[0]?.id ?? ''));
    } catch (reason) { onError(reason instanceof Error ? reason.message : 'Não foi possível carregar os canais de mensagem.'); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, [canManage]);

  const selectedChannel = channels.find((channel) => channel.id === selectedId) ?? null;
  async function createChannel(event: FormEvent) {
    event.preventDefault(); if (!newName.trim()) return;
    setCreating(true);
    try {
      const created = await api.createChatAiChannel({ displayName: newName.trim(), externalId: newExternalId.trim() || undefined });
      setChannels((current) => [created, ...current]); setSelectedId(created.id); setNewExternalId(''); setWebhook(null);
    } catch (reason) { onError(reason instanceof Error ? reason.message : 'Não foi possível criar o canal.'); }
    finally { setCreating(false); }
  }
  async function saveConnection(event: FormEvent) {
    event.preventDefault(); if (!selectedChannel || !backendUrl.trim() || !apiToken.trim()) return;
    setSaving(true);
    try {
      const result = await api.saveChatAiChannelConnection(selectedChannel.id, { backendUrl: backendUrl.trim(), apiToken: apiToken.trim(), queueId: Number(queueId) || 0, processingDelayMs: 5_000 });
      setWebhook(result); setApiToken(''); await load();
    } catch (reason) { onError(reason instanceof Error ? reason.message : 'Não foi possível configurar o webhook.'); }
    finally { setSaving(false); }
  }
  async function copyWebhook() {
    if (!webhook?.webhookUrl) return;
    try { await navigator.clipboard.writeText(webhook.webhookUrl); }
    catch { onError('Não foi possível copiar. Selecione a URL e copie manualmente.'); }
  }
  if (!canManage) return null;
  return <section className="channel-integration"><header className="channel-header"><div className="integration-brand"><span className="integration-icon channel-icon">◒</span><div><p className="eyebrow">Entrada de mensagens</p><h2>Canal ChatAI</h2><p>Receba mensagens diretamente no app, salve cada evento e processe a conversa em fila.</p></div></div><div className="channel-header-actions"><span className={`pill ${channels.some((channel) => channel.connection_status === 'active') ? 'success' : 'neutral'}`}>{loading ? 'Carregando' : channels.some((channel) => channel.connection_status === 'active') ? 'Canal configurado' : 'Sem webhook ativo'}</span><button className="button secondary" type="button" onClick={() => void load()} disabled={loading}>Atualizar</button></div></header>
    <div className="channel-body"><div className="channel-layout"><form className="channel-create" onSubmit={createChannel}><div><p className="eyebrow">1. Criar canal</p><h3>Identificar a origem</h3><p>Crie um registro para cada número ou instância. O identificador externo pode ser preenchido depois.</p></div><label>Nome do canal<input value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="Ex.: WhatsApp comercial" required /></label><label>Identificador da instância <small>Opcional</small><input value={newExternalId} onChange={(event) => setNewExternalId(event.target.value)} placeholder="Ex.: número ou ID do ChatAI" /></label><button className="button secondary" disabled={creating || !newName.trim()}>{creating ? 'Criando...' : 'Criar canal'}</button></form>
        <section className="channel-list"><header><p className="eyebrow">Canais</p><span>{channels.length}</span></header>{channels.length ? <div>{channels.map((channel) => <button type="button" className={`channel-row ${channel.id === selectedId ? 'selected' : ''}`} key={channel.id} onClick={() => { setSelectedId(channel.id); setWebhook(null); }}><span className={`status-dot ${channel.connection_status === 'active' ? 'open' : ''}`}></span><span><strong>{channel.display_name}</strong><small>{channel.connection_status === 'active' ? 'Webhook configurado' : 'Aguardando configuração'}</small></span></button>)}</div> : <p className="empty-inline">Crie o primeiro canal para gerar um webhook exclusivo.</p>}</section></div>
      {selectedChannel ? <form className="channel-connection" onSubmit={saveConnection}><header><div><p className="eyebrow">2. Configurar webhook</p><h3>{selectedChannel.display_name}</h3><p>Ao salvar, uma URL exclusiva será criada. Copie-a para o campo de webhook do ChatAI.</p></div><span className={`pill ${selectedChannel.connection_status === 'active' ? 'success' : 'neutral'}`}>{channelConnectionLabel(selectedChannel.connection_status)}</span></header><div className="channel-connection-fields"><label>URL do backend ChatAI<input type="url" value={backendUrl} onChange={(event) => setBackendUrl(event.target.value)} placeholder="https://sua-instancia.atendeai.chat" required /></label><label>API token<input type="password" value={apiToken} onChange={(event) => setApiToken(event.target.value)} autoComplete="new-password" placeholder="Cole somente quando for conectar" required /></label><label>Fila do ChatAI<input type="number" min="0" value={queueId} onChange={(event) => setQueueId(event.target.value)} /></label><button className="button primary" disabled={saving || !backendUrl.trim() || !apiToken.trim()}>{saving ? 'Gerando...' : selectedChannel.connection_status === 'active' ? 'Regenerar webhook' : 'Gerar webhook'}</button></div></form> : <div className="channel-empty"><strong>Selecione ou crie um canal</strong><p>Depois, configure o ChatAI para gerar a URL de recebimento.</p></div>}
      {webhook && <section className="webhook-result"><header><div><p className="eyebrow">Webhook criado</p><h3>Copie esta URL agora</h3><p>Por segurança, o token não pode ser recuperado depois. Para trocar a URL, regenere o webhook.</p></div><span className="connection-ok">Ativo</span></header>{webhook.webhookUrl ? <div className="webhook-url"><code>{webhook.webhookUrl}</code><button className="button secondary" type="button" onClick={() => void copyWebhook()}>Copiar URL</button></div> : <p className="webhook-warning">Defina `APP_PUBLIC_URL` com a URL pública HTTPS da API antes de usar este webhook fora do ambiente local.</p>}</section>}
      <section className="webhook-flow"><div><strong>1. ChatAI envia a mensagem</strong><span>para a URL exclusiva do canal</span></div><div><strong>2. API valida e registra</strong><span>sem duplicar contato ou mensagem</span></div><div><strong>3. Fila processa</strong><span>com debounce e bloqueio por conversa</span></div></section>
    </div>
  </section>;
}

function ChannelIntegration({ user, onError }: { user: PanelUser; onError: (message: string) => void }) {
  const [channels, setChannels] = useState<MessageChannel[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [newName, setNewName] = useState('WhatsApp principal');
  const [newExternalId, setNewExternalId] = useState('');
  const [backendUrl, setBackendUrl] = useState('');
  const [apiToken, setApiToken] = useState('');
  const [queueId, setQueueId] = useState('0');
  const [debounceSeconds, setDebounceSeconds] = useState('5');
  const [webhook, setWebhook] = useState<ChatAiConnectionResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [savingWebhook, setSavingWebhook] = useState(false);
  const [savingProcessing, setSavingProcessing] = useState(false);
  const [savingConnection, setSavingConnection] = useState(false);
  const [connectionTestPhone, setConnectionTestPhone] = useState('');
  const [testingConnection, setTestingConnection] = useState(false);
  const [connectionTestResult, setConnectionTestResult] = useState<string | null>(null);
  const [syncingTags, setSyncingTags] = useState(false);
  const [tagSyncResult, setTagSyncResult] = useState<ChatAiTagSyncResult | null>(null);
  const [simulationMessage, setSimulationMessage] = useState('Olá, gostaria de ver as bolsas disponíveis.');
  const [simulationName, setSimulationName] = useState('Cliente de teste');
  const [simulationPhone, setSimulationPhone] = useState('+5511999990000');
  const [simulating, setSimulating] = useState(false);
  const [simulationResult, setSimulationResult] = useState<string | null>(null);
  const canManage = user.role === 'owner' || user.role === 'admin';
  const selectedChannel = channels.find((channel) => channel.id === selectedId) ?? null;
  const processingDelayMs = Math.min(30_000, Math.max(1_000, (Number(debounceSeconds) || 5) * 1_000));

  const load = async () => {
    if (!canManage) { setLoading(false); return; }
    setLoading(true);
    try {
      const result = await api.channels();
      setChannels(result.data);
      setSelectedId((current) => current && result.data.some((channel) => channel.id === current) ? current : (result.data[0]?.id ?? ''));
    } catch (reason) { onError(reason instanceof Error ? reason.message : 'Não foi possível carregar os canais de mensagem.'); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, [canManage]);
  useEffect(() => {
    if (!selectedChannel) return;
    setBackendUrl(selectedChannel.backend_url ?? '');
    setQueueId(String(selectedChannel.outbound_queue_id ?? 0));
    setDebounceSeconds(String(Math.max(1, Math.round((selectedChannel.inbound_debounce_ms ?? 5_000) / 1_000))));
  }, [selectedId, channels]);
  useEffect(() => {
    let active = true;
    if (!selectedChannel?.webhook_configured) {
      setWebhook(null);
      return () => { active = false; };
    }
    api.chatAiWebhook(selectedChannel.id)
      .then((result) => { if (active) setWebhook(result); })
      .catch(() => { if (active) setWebhook(null); });
    return () => { active = false; };
  }, [selectedId, selectedChannel?.webhook_configured]);

  async function createChannel(event: FormEvent) {
    event.preventDefault(); if (!newName.trim()) return;
    setCreating(true);
    try {
      const created = await api.createChatAiChannel({ displayName: newName.trim(), externalId: newExternalId.trim() || undefined });
      setChannels((current) => [created, ...current]);
      setSelectedId(created.id);
      setNewExternalId('');
      setWebhook(null);
    } catch (reason) { onError(reason instanceof Error ? reason.message : 'Não foi possível criar o canal.'); }
    finally { setCreating(false); }
  }
  async function saveProcessing() {
    if (!selectedChannel) return;
    setSavingProcessing(true);
    try { await api.saveChatAiProcessing(selectedChannel.id, { processingDelayMs }); await load(); }
    catch (reason) { onError(reason instanceof Error ? reason.message : 'Não foi possível salvar o padrão da fila.'); }
    finally { setSavingProcessing(false); }
  }
  async function generateWebhook() {
    if (!selectedChannel) return;
    setSavingWebhook(true);
    try {
      const result = await api.generateChatAiWebhook(selectedChannel.id, { processingDelayMs });
      setWebhook(result);
      await load();
    } catch (reason) { onError(reason instanceof Error ? reason.message : 'Não foi possível gerar a URL do webhook.'); }
    finally { setSavingWebhook(false); }
  }
  async function saveConnection(event: FormEvent) {
    event.preventDefault(); if (!selectedChannel || !backendUrl.trim() || !apiToken.trim()) return;
    setSavingConnection(true);
    try {
      const result = await api.saveChatAiChannelConnection(selectedChannel.id, { backendUrl: backendUrl.trim(), apiToken: apiToken.trim(), queueId: Number(queueId) || 0, processingDelayMs });
      setWebhook((current) => result.webhookUrl ? result : current);
      setApiToken('');
      await load();
    } catch (reason) { onError(reason instanceof Error && reason.message === 'invalid_request' ? 'Confira a URL, o token e a fila do ChatAI.' : reason instanceof Error ? reason.message : 'Não foi possível conectar o ChatAI.'); }
    finally { setSavingConnection(false); }
  }
  async function testConnection(event: FormEvent) {
    event.preventDefault(); if (!selectedChannel || !connectionTestPhone.trim()) return;
    setTestingConnection(true); setConnectionTestResult(null);
    try {
      const result = await api.testChatAiChannelConnection(selectedChannel.id, connectionTestPhone.trim());
      setConnectionTestResult(result.recipientExists ? 'Conexao autenticada. O numero existe no WhatsApp.' : 'Conexao autenticada, mas o numero nao foi localizado no WhatsApp.');
    } catch (reason) { onError(reason instanceof Error ? reason.message : 'Nao foi possivel validar a conexao do ChatAI.'); }
    finally { setTestingConnection(false); }
  }
  async function syncTags() {
    if (!selectedChannel) return;
    setSyncingTags(true); setTagSyncResult(null);
    try { setTagSyncResult(await api.syncChatAiTags(selectedChannel.id)); }
    catch (reason) { onError(reason instanceof Error && reason.message === 'chatai_remote_request_failed' ? 'O ChatAI recusou a consulta. Verifique URL, token e se a conexão está marcada como padrão.' : reason instanceof Error ? reason.message : 'Não foi possível consultar as tags do ChatAI.'); }
    finally { setSyncingTags(false); }
  }
  async function copyWebhook() {
    if (!webhook?.webhookUrl) return;
    try { await navigator.clipboard.writeText(webhook.webhookUrl); }
    catch { onError('Não foi possível copiar. Selecione a URL e copie manualmente.'); }
  }
  async function simulateInbound(event: FormEvent) {
    event.preventDefault(); if (!selectedChannel || !simulationMessage.trim() || !simulationPhone.trim()) return;
    setSimulating(true); setSimulationResult(null);
    try {
      const result = await api.simulateChatAiInbound(selectedChannel.id, { message: simulationMessage.trim(), contactName: simulationName.trim() || 'Cliente de teste', phoneE164: simulationPhone.trim(), queueId: Number(queueId) || 0 });
      setSimulationResult(result.duplicate ? 'O evento já existia e foi ignorado pela idempotência.' : `Recebido como ${result.normalized.type}. A conversa entrou na fila e o Trace foi atualizado.`);
    } catch (reason) { onError(reason instanceof Error ? reason.message : 'Não foi possível simular o recebimento.'); }
    finally { setSimulating(false); }
  }

  if (!canManage) return null;
  return <section className="channel-integration">
    <header className="channel-header"><div className="integration-brand"><span className="integration-icon channel-icon">◒</span><div><p className="eyebrow">Entrada de mensagens</p><h2>Canal ChatAI</h2><p>O app recebe, normaliza e registra a mensagem antes de encaminhá-la à fila do agente.</p></div></div><div className="channel-header-actions"><span className={`pill ${channels.some((channel) => channel.webhook_configured) ? 'success' : 'neutral'}`}>{loading ? 'Carregando' : channels.some((channel) => channel.webhook_configured) ? 'Webhook pronto' : 'Sem webhook'}</span><button className="button secondary" type="button" onClick={() => void load()} disabled={loading}>Atualizar</button></div></header>
    <div className="channel-body">
      {selectedChannel && <form className="webhook-simulator" onSubmit={simulateInbound}><header><div><p className="eyebrow">Teste local</p><h3>Simular payload do ChatAI</h3><p>Gera o mesmo envelope do webhook recebido (`body.mensagem` com Meta serializado) e percorre normalização, fila e Trace sem chamada externa.</p></div><span className="pill neutral">Não envia WhatsApp</span></header><div className="webhook-simulator-fields"><label>Mensagem de teste<textarea value={simulationMessage} onChange={(event) => setSimulationMessage(event.target.value)} rows={2} /></label><label>Nome<input value={simulationName} onChange={(event) => setSimulationName(event.target.value)} /></label><label>Telefone de teste<input value={simulationPhone} onChange={(event) => setSimulationPhone(event.target.value)} inputMode="tel" /></label><button className="button primary" disabled={simulating || !simulationMessage.trim() || !simulationPhone.trim()}>{simulating ? 'Simulando...' : 'Simular recebimento'}</button></div>{simulationResult && <p className="simulation-result">{simulationResult}</p>}</form>}
      <div className="channel-layout"><form className="channel-create" onSubmit={createChannel}><div><p className="eyebrow">1. Criar canal</p><h3>Identificar a origem</h3><p>Crie um registro para cada número ou instância. A URL do webhook poderá ser criada agora, sem credenciais do ChatAI.</p></div><label>Nome do canal<input value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="Ex.: WhatsApp comercial" required /></label><label>Identificador da instância <small>Opcional</small><input value={newExternalId} onChange={(event) => setNewExternalId(event.target.value)} placeholder="Ex.: número ou ID do ChatAI" /></label><button className="button secondary" disabled={creating || !newName.trim()}>{creating ? 'Criando...' : 'Criar canal'}</button></form>
        <section className="channel-list"><header><p className="eyebrow">Canais</p><span>{channels.length}</span></header>{channels.length ? <div>{channels.map((channel) => <button type="button" className={`channel-row ${channel.id === selectedId ? 'selected' : ''}`} key={channel.id} onClick={() => { setSelectedId(channel.id); setWebhook(null); }}><span className={`status-dot ${channel.webhook_configured ? 'open' : ''}`}></span><span><strong>{channel.display_name}</strong><small>{channel.connection_status === 'active' ? 'Entrada e saída conectadas' : channel.webhook_configured ? 'Webhook gerado' : 'Aguardando webhook'}</small></span></button>)}</div> : <p className="empty-inline">Crie o primeiro canal para gerar um webhook exclusivo.</p>}</section></div>
      {selectedChannel ? <>
        {selectedChannel.connection_status === 'active' && <>
          <ChatAiConnectionTest phone={connectionTestPhone} onPhoneChange={setConnectionTestPhone} busy={testingConnection} result={connectionTestResult} onSubmit={testConnection} />
          <section className="chatai-tag-sync">
            <div><p className="eyebrow">Catálogo de tags</p><h3>Importar tags do ChatAI</h3><p>Lê as tags presentes nos contatos do canal e cria somente o catálogo local para regras e agentes. Contatos, telefones e mensagens não são copiados.</p></div>
            <button className="button secondary" type="button" onClick={() => void syncTags()} disabled={syncingTags}>{syncingTags ? 'Consultando...' : 'Verificar e importar tags'}</button>
            {tagSyncResult && <div className="chatai-tag-sync-result">
              <strong>{tagSyncResult.found} encontrada{tagSyncResult.found === 1 ? '' : 's'} · {tagSyncResult.imported} nova{tagSyncResult.imported === 1 ? '' : 's'}</strong>
              <span>{tagSyncResult.existing} já existia{tagSyncResult.existing === 1 ? '' : 'm'} neste painel.</span>
              {tagSyncResult.tags.length > 0 && <div className="tag-catalog">{tagSyncResult.tags.map((tag) => <span className="managed-tag" key={tag.slug} style={tag.color ? { borderColor: tag.color, color: tag.color } : undefined}>{tag.name}<small>#{tag.slug}</small></span>)}</div>}
            </div>}
          </section>
        </>}
        <section className="webhook-setup"><header><div><p className="eyebrow">2. Webhook de entrada</p><h3>Gerar URL exclusiva</h3><p>O token é armazenado cifrado e validado por hash. A URL permanece disponível somente para owner e admin deste canal.</p></div><span className={`pill ${selectedChannel.webhook_configured ? 'success' : 'neutral'}`}>{selectedChannel.webhook_configured ? 'URL criada' : 'Pendente'}</span></header><div className="webhook-setup-fields"><label>Janela de agrupamento<input type="number" min="1" max="30" value={debounceSeconds} onChange={(event) => setDebounceSeconds(event.target.value)} /><small>segundos · padrão recomendado: 5</small></label><div className="webhook-actions"><button className="button secondary" type="button" onClick={() => void saveProcessing()} disabled={savingProcessing}>{savingProcessing ? 'Salvando...' : 'Salvar padrão da fila'}</button><button className="button primary" type="button" onClick={() => void generateWebhook()} disabled={savingWebhook}>{savingWebhook ? 'Gerando...' : selectedChannel.webhook_configured ? 'Gerar nova URL' : 'Gerar URL do webhook'}</button></div></div><p className="queue-explainer"><strong>Fluxo escalável:</strong> API responde rápido, grava o evento com idempotência, agrupa mensagens por {Math.max(1, Math.round(processingDelayMs / 1_000))} s e o worker BullMQ processa em segundo plano com tentativas e bloqueio por conversa.</p></section>
        {webhook && <section className="webhook-result"><header><div><p className="eyebrow">Webhook do canal</p><h3>{webhook.webhookUrl ? 'URL configurada' : 'URL precisa ser renovada'}</h3><p>{webhook.webhookUrl ? 'Ela permanece visível para owner e admin. Gere uma nova URL somente se precisar invalidar a anterior.' : 'Este webhook foi criado antes do armazenamento cifrado. Gere uma nova URL uma única vez para mantê-la visível neste painel.'}</p></div><span className={webhook.webhookUrl ? 'connection-ok' : 'pill warning'}>{webhook.webhookUrl ? 'Pronto' : 'Ação necessária'}</span></header>{webhook.webhookUrl ? <div className="webhook-url"><code>{webhook.webhookUrl}</code><button className="button secondary" type="button" onClick={() => void copyWebhook()}>Copiar URL</button></div> : null}</section>}
        <form className="channel-connection" onSubmit={saveConnection}><header><div><p className="eyebrow">3. Conectar saída pelo ChatAI</p><h3>Etapa opcional</h3><p>Use quando for habilitar o envio de mensagens. A URL acima já pode receber mensagens sem estas credenciais.</p></div><span className={`pill ${selectedChannel.connection_status === 'active' ? 'success' : 'neutral'}`}>{selectedChannel.connection_status === 'active' ? 'Saída conectada' : 'Não conectado'}</span></header><div className="channel-connection-fields"><label>URL do backend ChatAI<input type="url" value={backendUrl} onChange={(event) => setBackendUrl(event.target.value)} placeholder="https://sua-instancia.atendeai.chat" required /></label><label>API token<input type="password" value={apiToken} onChange={(event) => setApiToken(event.target.value)} autoComplete="new-password" placeholder="Cole somente quando for conectar" required /></label><label>Fila de envio no ChatAI<input type="number" min="0" value={queueId} onChange={(event) => setQueueId(event.target.value)} /><small>Usada somente no envio</small></label><button className="button primary" disabled={savingConnection || !backendUrl.trim() || !apiToken.trim()}>{savingConnection ? 'Conectando...' : 'Salvar conexão de saída'}</button></div></form>
      </> : <div className="channel-empty"><strong>Selecione ou crie um canal</strong><p>Depois, gere a URL que receberá as mensagens da plataforma.</p></div>}
      <section className="webhook-flow"><div><strong>1. Plataforma envia</strong><span>para a URL exclusiva do canal</span></div><div><strong>2. API normaliza e registra</strong><span>sem duplicar contato ou mensagem</span></div><div><strong>3. Fila processa</strong><span>com retries, debounce e bloqueio por conversa</span></div></section>
    </div>
  </section>;
}

function ChatAiConnectionTest({ phone, onPhoneChange, busy, result, onSubmit }: { phone: string; onPhoneChange: (value: string) => void; busy: boolean; result: string | null; onSubmit: (event: FormEvent) => void }) {
  return <form className="chatai-connection-test" onSubmit={onSubmit}><div><p className="eyebrow">Validacao segura</p><h3>Testar conexao de saida</h3><p>Confere URL e token no ChatAI validando um numero, sem enviar mensagem.</p></div><label>Numero para validar<input value={phone} onChange={(event) => onPhoneChange(event.target.value)} inputMode="tel" placeholder="5511999999999" required /></label><button className="button secondary" disabled={busy || !phone.trim()}>{busy ? 'Validando...' : 'Testar conexao'}</button>{result && <p className="connection-test-result">{result}</p>}</form>;
}

const agentToolLabels: Record<AgentKey, string[]> = {
  attendant: ['Memória comercial', 'Transferência humana'],
  support: ['Memória comercial', 'Status de pedido'],
  product: ['Busca de catálogo', 'Fotos de produto']
};

function Integrations({ user, onError }: { user: PanelUser; onError: (message: string) => void }) {
  const [configuration, setConfiguration] = useState<AiConfiguration | null>(null);
  const [promptVersions, setPromptVersions] = useState<AgentPromptVersion[]>([]);
  const [selectedAgentKey, setSelectedAgentKey] = useState<AgentKey>('attendant');
  const [selectedPromptId, setSelectedPromptId] = useState<string | null>(null);
  const [showPromptComposer, setShowPromptComposer] = useState(false);
  const [draftInstructions, setDraftInstructions] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [testMessage, setTestMessage] = useState('Olá, estou procurando uma bolsa para maternidade.');
  const [testResult, setTestResult] = useState<PromptTestResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState(false);
  const [savingAgent, setSavingAgent] = useState<AgentKey | null>(null);
  const [savingPrompt, setSavingPrompt] = useState(false);
  const [activatingPrompt, setActivatingPrompt] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const canManage = user.role === 'owner' || user.role === 'admin';

  const load = async () => {
    if (!canManage) { setLoading(false); return; }
    setLoading(true);
    try {
      const [nextConfiguration, nextPrompts] = await Promise.all([api.aiConfiguration(), api.agentPromptVersions()]);
      setConfiguration(nextConfiguration); setPromptVersions(nextPrompts.data);
      setSelectedPromptId((current) => current && nextPrompts.data.some((prompt) => prompt.id === current) ? current : (nextPrompts.data.find((prompt) => prompt.agentKey === selectedAgentKey && prompt.status === 'active')?.id ?? null));
    } catch (reason) { onError(reason instanceof Error ? reason.message : 'Não foi possível carregar a central de agentes.'); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, [canManage]);

  const selectedAgent = configuration?.agents.find((agent) => agent.key === selectedAgentKey) ?? null;
  const agentPrompts = promptVersions.filter((prompt) => prompt.agentKey === selectedAgentKey).sort((a, b) => b.version - a.version);
  const activePrompt = agentPrompts.find((prompt) => prompt.status === 'active') ?? null;
  const selectedPrompt = agentPrompts.find((prompt) => prompt.id === selectedPromptId) ?? activePrompt;

  function selectAgent(agentKey: AgentKey) {
    setSelectedAgentKey(agentKey); setShowPromptComposer(false); setTestResult(null);
    setSelectedPromptId(promptVersions.find((prompt) => prompt.agentKey === agentKey && prompt.status === 'active')?.id ?? null);
  }
  function startPromptVersion() { setDraftInstructions(activePrompt?.instructions ?? ''); setShowPromptComposer(true); }
  async function saveKey(event: FormEvent) {
    event.preventDefault(); if (!apiKey.trim()) return;
    setSavingKey(true);
    try { await api.saveOpenAiKey(apiKey.trim()); setApiKey(''); await load(); }
    catch (reason) { onError(reason instanceof Error ? reason.message : 'Não foi possível salvar a chave.'); }
    finally { setSavingKey(false); }
  }
  async function updateAgent(agentKey: AgentKey, model: AgentModel, enabled: boolean) {
    setSavingAgent(agentKey);
    try {
      const saved = await api.updateAiAgent(agentKey, { model, enabled });
      setConfiguration((current) => current ? { ...current, agents: current.agents.map((agent) => agent.key === agentKey ? { ...agent, ...saved } : agent) } : current);
    } catch (reason) { onError(reason instanceof Error ? reason.message : 'Não foi possível atualizar o agente.'); }
    finally { setSavingAgent(null); }
  }
  async function createPromptVersion(event: FormEvent) {
    event.preventDefault(); if (draftInstructions.trim().length < 80) return;
    setSavingPrompt(true);
    try {
      const created = await api.createAgentPromptVersion({ agentKey: selectedAgentKey, instructions: draftInstructions });
      setPromptVersions((current) => [created, ...current]); setSelectedPromptId(created.id); setShowPromptComposer(false);
    } catch (reason) { onError(reason instanceof Error ? reason.message : 'Não foi possível criar a versão do prompt.'); }
    finally { setSavingPrompt(false); }
  }
  async function activatePrompt(prompt: AgentPromptVersion) {
    setActivatingPrompt(prompt.id);
    try {
      const activated = await api.activateAgentPromptVersion(prompt.id);
      setPromptVersions((current) => current.map((item) => item.agentKey === activated.agentKey && item.status === 'active' && item.id !== activated.id ? { ...item, status: 'archived' } : item.id === activated.id ? activated : item));
      setSelectedPromptId(activated.id);
    } catch (reason) { onError(reason instanceof Error ? reason.message : 'Não foi possível ativar esta versão.'); }
    finally { setActivatingPrompt(null); }
  }
  async function runPromptTest(event: FormEvent) {
    event.preventDefault(); if (!testMessage.trim()) return;
    setTesting(true); setTestResult(null);
    try { setTestResult(await api.testPrompt(selectedAgentKey, testMessage.trim(), selectedPrompt?.id)); }
    catch (reason) { onError(reason instanceof Error ? reason.message : 'Não foi possível executar o teste.'); }
    finally { setTesting(false); }
  }

  if (!canManage) return <div className="empty-page"><Empty title="Acesso restrito" text="Somente owner e admin podem configurar os agentes." /></div>;
  return <section className="agent-studio">
    <header className="agent-studio-header"><div><p className="eyebrow">OpenAI · Agents SDK</p><h2>Central de agentes</h2><p>Configure especialistas, controle a versão ativa de cada prompt e teste o comportamento antes de liberar no canal.</p></div><div className="agent-studio-status"><span className={`pill ${configuration?.provider.configured ? 'success' : 'warning'}`}>{loading ? 'Carregando' : configuration?.provider.configured ? 'Provedor configurado' : 'Chave pendente'}</span><button className="button secondary" type="button" onClick={() => void load()} disabled={loading}>Atualizar</button></div></header>
    <div className="agent-studio-layout">
      <aside className="agent-roster" aria-label="Agentes disponíveis"><div className="agent-roster-head"><strong>Equipe de IA</strong><span>{configuration?.agents.filter((agent) => agent.enabled).length ?? 0}/3 ativos</span></div>{configuration?.agents.map((agent) => <button type="button" key={agent.key} onClick={() => selectAgent(agent.key)} className={`agent-roster-item ${selectedAgentKey === agent.key ? 'selected' : ''}`}><span className={`agent-monogram ${agent.key}`}>{agent.key === 'attendant' ? 'A' : agent.key === 'support' ? 'S' : 'P'}</span><span><strong>{agent.label}</strong><small>{agent.enabled ? 'Ativo' : 'Pausado'} · {agent.model.replace('gpt-5.6-', '')}</small></span><i className={agent.enabled ? 'live' : ''} aria-label={agent.enabled ? 'Ativo' : 'Pausado'} /></button>)}</aside>
      <main className="agent-workbench">
        {selectedAgent && <><header className="agent-workbench-header"><div><p className="eyebrow">{selectedAgent.key === 'attendant' ? 'Agente de entrada' : 'Especialista interno'}</p><h3>{selectedAgent.label}</h3><p>{selectedAgent.responsibility}</p></div><label className="toggle agent-toggle"><input type="checkbox" checked={selectedAgent.enabled} onChange={(event) => void updateAgent(selectedAgent.key, selectedAgent.model, event.target.checked)} disabled={savingAgent === selectedAgent.key} /><span>{selectedAgent.enabled ? 'Ativo' : 'Pausado'}</span></label></header>
          <div className="agent-settings-row"><label>Modelo<select value={selectedAgent.model} onChange={(event) => void updateAgent(selectedAgent.key, event.target.value as AgentModel, selectedAgent.enabled)} disabled={savingAgent === selectedAgent.key}><option value="gpt-5.6-luna">GPT-5.6 Luna</option><option value="gpt-5.6-terra">GPT-5.6 Terra</option><option value="gpt-5.6-sol">GPT-5.6 Sol</option></select><small>{savingAgent === selectedAgent.key ? 'Salvando configuração…' : modelPurpose(selectedAgent.model)}</small></label><div className="agent-tool-list"><span>Ferramentas permitidas</span><div>{agentToolLabels[selectedAgent.key].map((tool) => <b key={tool}>{tool}</b>)}</div></div></div>
          <section className="agent-prompt-area"><header><div><p className="eyebrow">Prompt e versões</p><h3>{activePrompt ? `Versão ativa v${activePrompt.version}` : 'Nenhuma versão ativa'}</h3><p>{activePrompt ? `Ativada para novas execuções · ${activePrompt.checksum.slice(0, 12)}` : 'Crie a primeira versão para este agente.'}</p></div><button className="button primary" type="button" onClick={startPromptVersion}>Nova versão</button></header><div className="agent-version-layout"><aside className="prompt-version-list" aria-label="Versões do prompt"><strong>Histórico</strong>{agentPrompts.map((prompt) => <button type="button" key={prompt.id} onClick={() => { setSelectedPromptId(prompt.id); setShowPromptComposer(false); }} className={`prompt-version-row ${selectedPrompt?.id === prompt.id ? 'selected' : ''}`}><span><b>v{prompt.version}</b><small>{promptVersionLabel(prompt.status)}</small></span><time>{formatDate(prompt.createdAt)}</time></button>)}</aside><div className="prompt-version-content">{showPromptComposer ? <form className="prompt-composer" onSubmit={createPromptVersion}><label>Instruções da nova versão<textarea value={draftInstructions} onChange={(event) => setDraftInstructions(event.target.value)} rows={15} minLength={80} required /></label><div><small>Uma nova versão nasce como rascunho. Só passa a valer após ser ativada.</small><span><button className="button secondary" type="button" onClick={() => setShowPromptComposer(false)}>Cancelar</button><button className="button primary" disabled={savingPrompt || draftInstructions.trim().length < 80}>{savingPrompt ? 'Salvando…' : 'Criar rascunho'}</button></span></div></form> : selectedPrompt ? <><div className="prompt-version-summary"><span className={`prompt-status ${selectedPrompt.status}`}>{promptVersionLabel(selectedPrompt.status)}</span><span>v{selectedPrompt.version} · {selectedPrompt.checksum.slice(0, 12)}</span>{selectedPrompt.status !== 'active' && <button type="button" className="button secondary" onClick={() => void activatePrompt(selectedPrompt)} disabled={activatingPrompt === selectedPrompt.id}>{activatingPrompt === selectedPrompt.id ? 'Ativando…' : 'Ativar esta versão'}</button>}</div><pre className="prompt-preview">{selectedPrompt.instructions}</pre></> : <Empty title="Sem versão selecionada" text="Escolha ou crie um prompt para revisar seu conteúdo." />}</div></div></section>
        </>}
      </main>
      <aside className="agent-test-panel"><div><p className="eyebrow">Ambiente de teste</p><h3>Validar cenário</h3><p>Não envia mensagens para o WhatsApp e não altera conversas reais.</p></div><form onSubmit={runPromptTest}><label>Versão avaliada<input value={selectedPrompt ? `v${selectedPrompt.version} · ${promptVersionLabel(selectedPrompt.status)}` : 'Sem versão'} readOnly /></label><label>Mensagem de teste<textarea value={testMessage} onChange={(event) => setTestMessage(event.target.value)} rows={7} /></label><button className="button primary" disabled={testing || !testMessage.trim()}>{testing ? 'Testando…' : 'Executar teste'}</button></form>{testResult && <div className={`agent-test-result ${testResult.status}`}><strong>{testResult.status === 'completed' ? 'Teste concluído' : 'Teste aguardando ativação'}</strong><p>{promptTestReason(testResult.reason, testResult.agentKey, testResult.model)}{testResult.promptVersion ? ` Versão ${testResult.promptVersion}.` : ''}</p></div>}<details className="agent-provider-settings"><summary>Credenciais do provedor</summary><form onSubmit={saveKey}><p>A chave é cifrada no backend e não aparece novamente neste painel.</p><label>OpenAI API key<input type="password" autoComplete="new-password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="Cole somente quando for ativar" /></label><button className="button secondary" disabled={savingKey || !apiKey.trim()}>{savingKey ? 'Salvando…' : configuration?.provider.configured ? 'Substituir chave' : 'Salvar chave'}</button></form></details></aside>
    </div>
  </section>;
}

function LegacyAgentIntegrations({ user, onError }: { user: PanelUser; onError: (message: string) => void }) {
  const [configuration, setConfiguration] = useState<AiConfiguration | null>(null);
  const [loading, setLoading] = useState(true);
  const [apiKey, setApiKey] = useState('');
  const [savingKey, setSavingKey] = useState(false);
  const [savingAgent, setSavingAgent] = useState<AgentKey | null>(null);
  const [testAgent, setTestAgent] = useState<AgentKey>('attendant');
  const [testMessage, setTestMessage] = useState('Olá, estou procurando uma bolsa para maternidade.');
  const [testResult, setTestResult] = useState<PromptTestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const canManage = user.role === 'owner' || user.role === 'admin';
  const load = async () => {
    if (!canManage) { setLoading(false); return; }
    setLoading(true);
    try { setConfiguration(await api.aiConfiguration()); }
    catch (reason) { onError(reason instanceof Error ? reason.message : 'Não foi possível carregar a configuração de IA.'); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, [canManage]);
  async function saveKey(event: FormEvent) {
    event.preventDefault(); if (!apiKey.trim()) return;
    setSavingKey(true);
    try { await api.saveOpenAiKey(apiKey.trim()); setApiKey(''); await load(); }
    catch (reason) { onError(reason instanceof Error ? reason.message : 'Não foi possível salvar a chave.'); }
    finally { setSavingKey(false); }
  }
  async function updateAgent(agentKey: AgentKey, model: AgentModel, enabled: boolean) {
    setSavingAgent(agentKey);
    try {
      const saved = await api.updateAiAgent(agentKey, { model, enabled });
      setConfiguration((current) => current ? { ...current, agents: current.agents.map((agent) => agent.key === agentKey ? { ...agent, ...saved } : agent) } : current);
    } catch (reason) { onError(reason instanceof Error ? reason.message : 'Não foi possível atualizar o agente.'); }
    finally { setSavingAgent(null); }
  }
  async function runPromptTest(event: FormEvent) {
    event.preventDefault(); if (!testMessage.trim()) return;
    setTesting(true); setTestResult(null);
    try { setTestResult(await api.testPrompt(testAgent, testMessage.trim())); }
    catch (reason) { onError(reason instanceof Error ? reason.message : 'Não foi possível executar o teste.'); }
    finally { setTesting(false); }
  }
  return <section className="integrations-page"><header className="page-header"><div><p className="eyebrow">Conectores</p><h1>Integrações</h1><p className="page-description">Conexões externas e a configuração segura dos agentes que operam o atendimento.</p></div></header><div className="integration-list"><article><div><span className="integration-icon">B</span><div><h2>Bling</h2><p>Catálogo, estoque e consulta de pedidos.</p></div></div><span className="pill warning">Aguardando OAuth</span></article><article><div><span className="integration-icon">◒</span><div><h2>Canal de mensagens</h2><p>Envio e confirmação de mensagens ao cliente.</p></div></div><span className="pill warning">Aguardando credenciais</span></article></div>{canManage && <section className="ai-configuration"><header className="ai-configuration-head"><div><p className="eyebrow">OpenAI · Agents SDK</p><h2>Agentes e modelos</h2><p>O Atendimento fala com a cliente. Suporte e Produtos são especialistas internos chamados quando necessário.</p></div><span className={`pill ${configuration?.provider.configured ? 'success' : 'warning'}`}>{loading ? 'Carregando' : configuration?.provider.configured ? 'Chave configurada' : 'Chave não configurada'}</span></header><div className="ai-setup-grid"><form className="ai-key-card" onSubmit={saveKey}><div><h3>Chave da API</h3><p>O valor é enviado uma única vez ao backend, cifrado e nunca aparece novamente no painel.</p></div><label>OpenAI API key<input type="password" autoComplete="new-password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="Cole somente quando for ativar" /></label><button className="button primary" disabled={savingKey || !apiKey.trim()}>{savingKey ? 'Salvando...' : configuration?.provider.configured ? 'Substituir chave' : 'Salvar chave'}</button></form><article className="ai-flow-card"><p className="eyebrow">Fluxo protegido</p><ol><li><strong>Atendimento</strong><span>decide e responde</span></li><li><strong>Suporte</strong><span>esclarece dúvidas</span></li><li><strong>Produtos</strong><span>traz dados reais</span></li><li><strong>Humano</strong><span>fecha e resolve exceções</span></li></ol></article></div><div className="agent-model-grid">{configuration?.agents.map((agent) => <article className={`agent-model-card ${agent.enabled ? '' : 'disabled'}`} key={agent.key}><div className="agent-model-heading"><div><span className="agent-key">{agent.key === 'attendant' ? 'A' : agent.key === 'support' ? 'S' : 'P'}</span><div><h3>{agent.label}</h3><p>{agent.responsibility}</p></div></div><label className="toggle"><input type="checkbox" checked={agent.enabled} onChange={(event) => void updateAgent(agent.key, agent.model, event.target.checked)} disabled={savingAgent === agent.key} /><span>Ativo</span></label></div><label>Modelo<select value={agent.model} onChange={(event) => void updateAgent(agent.key, event.target.value as AgentModel, agent.enabled)} disabled={savingAgent === agent.key}><option value="gpt-5.6-luna">GPT-5.6 Luna · alto volume</option><option value="gpt-5.6-terra">GPT-5.6 Terra · equilíbrio</option><option value="gpt-5.6-sol">GPT-5.6 Sol · alta complexidade</option></select></label><small>{savingAgent === agent.key ? 'Salvando configuração...' : modelPurpose(agent.model)}</small></article>)}</div><form className="prompt-test-card" onSubmit={runPromptTest}><header><div><p className="eyebrow">Teste opcional</p><h3>Conversar com a estrutura</h3><p>Use para validar o roteamento de Atendimento, Suporte e Produtos antes de liberar o canal real.</p></div><span className="pill neutral">Não envia WhatsApp</span></header><div className="prompt-test-fields"><label>Agente inicial<select value={testAgent} onChange={(event) => setTestAgent(event.target.value as AgentKey)}>{configuration?.agents.filter((agent) => agent.enabled).map((agent) => <option value={agent.key} key={agent.key}>{agent.label}</option>)}</select></label><label>Mensagem de teste<textarea value={testMessage} onChange={(event) => setTestMessage(event.target.value)} rows={3} /></label><button className="button primary" disabled={testing || !testMessage.trim()}>{testing ? 'Testando...' : 'Executar teste'}</button></div>{testResult && <div className={`prompt-test-result ${testResult.status}`}><strong>{testResult.status === 'completed' ? 'Teste concluído' : 'Teste aguardando ativação'}</strong><p>{promptTestReason(testResult.reason, testResult.agentKey, testResult.model)}</p></div>}</form></section>}{!canManage && <div className="empty-page"><Empty title="Acesso restrito" text="Somente owner e admin podem configurar integrações e agentes." /></div>}</section>;
}

function slugify(value: string) { return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64); }
function policyActionLabel(action: RoutingPolicy['action']['type']) { return ({ continue: 'Seguir agente', handoff: 'Equipe humana', pause_automation: 'Pausar IA' } as Record<string, string>)[action]; }
function policySummary(policy: RoutingPolicy) { const tags = [...(policy.conditions.hasTagsAll ?? []), ...(policy.conditions.hasTagsAny ?? [])]; const tagText = tags.length ? tags.map((tag) => `#${tag}`).join(', ') : 'qualquer conversa'; return `Ao identificar ${tagText}, ${policyActionLabel(policy.action.type).toLowerCase()}.`; }
function promptVersionLabel(status: AgentPromptVersion['status']) { return ({ active: 'Ativa', draft: 'Rascunho', archived: 'Arquivada' } as Record<AgentPromptVersion['status'], string>)[status]; }
function modelPurpose(model: AgentModel) { return ({ 'gpt-5.6-luna': 'Boa escolha para fluxos repetitivos e alto volume.', 'gpt-5.6-terra': 'Mais contexto e qualidade com custo equilibrado.', 'gpt-5.6-sol': 'Use em casos complexos validados por avaliação.' } as Record<AgentModel, string>)[model]; }
function blingStatusLabel(status?: BlingConnectionStatus['status']) { return ({ not_configured: 'Não configurado', pending: 'Aguardando OAuth', active: 'Conectado', disabled: 'Desativado', error: 'Atenção necessária' } as Record<string, string>)[status ?? 'not_configured']; }
function blingStatusTone(status?: BlingConnectionStatus['status']) { return status === 'active' ? 'success' : status === 'error' ? 'warning' : 'neutral'; }
function blingSyncStatusLabel(status: BlingCatalogSyncRun['status']) { return ({ queued: 'Na fila', running: 'Em andamento', waiting_configuration: 'Aguardando ativação', completed: 'Concluída', failed: 'Falhou', cancelled: 'Cancelada' } as Record<BlingCatalogSyncRun['status'], string>)[status]; }
function blingSyncError(code: string) { return ({ integration_not_configured: 'A conexão não estava ativa no momento da execução.', catalog_sync_adapter_not_enabled: 'A conexão foi validada; a leitura de produtos ainda será ativada no adaptador de catálogo.' } as Record<string, string>)[code] ?? 'A sincronização precisa de revisão técnica.'; }
function channelConnectionLabel(status: MessageChannel['connection_status']) { return status === 'active' ? 'Webhook ativo' : status === 'disabled' ? 'Desativado' : 'Aguardando conexão'; }
function promptTestReason(reason: string | undefined, agentKey: AgentKey, model: AgentModel) { if (reason === 'openai_api_key_not_configured') return 'Cadastre a chave da OpenAI para liberar o teste. Nenhuma chamada foi feita.'; if (reason === 'agents_sdk_runtime_not_enabled') return `A chave e o modelo ${model} estão prontos, mas o runtime do Agents SDK ainda será conectado antes de qualquer resposta.`; if (reason === 'agent_disabled') return `Ative o agente ${agentKey} antes de testá-lo.`; return 'O resultado do teste aparecerá aqui.'; }
function formatTraceDuration(milliseconds: number) { if (milliseconds < 1000) return 'menos de 1 s'; if (milliseconds < 60000) return `${Math.round(milliseconds / 1000)} s no total`; return `${Math.floor(milliseconds / 60000)} min ${Math.round((milliseconds % 60000) / 1000)} s no total`; }
function formatTraceGap(milliseconds: number) { if (milliseconds < 1000) return 'Imediatamente'; if (milliseconds < 60000) return `+${Math.round(milliseconds / 1000)} s`; return `+${Math.floor(milliseconds / 60000)} min`; }
function traceEventOrder(eventType: string) { if (eventType.startsWith('webhook.')) return 1; if (eventType.startsWith('queue.')) return 2; if (eventType === 'agent.run_started') return 3; if (eventType.startsWith('agent.tool_')) return 4; if (eventType === 'agent.run_finished') return 5; if (eventType === 'agent.handoff') return 6; return 7; }
function traceFilterLabel(filter: 'all' | 'webhook' | 'queue' | 'agent' | 'failed') { return ({ all: 'Tudo', webhook: 'Webhook', queue: 'Fila', agent: 'Agente', failed: 'Falhas' } as Record<string, string>)[filter]; }
function traceIcon(eventType: string) { return eventType.startsWith('webhook.') ? '◒' : eventType.startsWith('queue.') ? '≋' : '✦'; }
function traceEventLabel(eventType: string) { return ({ 'webhook.received': 'Webhook recebido e normalizado', 'webhook.simulated': 'Webhook simulado e normalizado', 'webhook.duplicate': 'Evento duplicado ignorado', 'queue.conversation_scheduled': 'Conversa colocada na fila', 'agent.run_started': 'Agente iniciou a análise', 'agent.run_finished': 'Agente concluiu a execução', 'agent.tool_started': 'Agente chamou uma ferramenta', 'agent.tool_finished': 'Ferramenta respondeu ao agente', 'agent.tool_rejected': 'Ferramenta bloqueada pela política', 'agent.skipped': 'Agente não executado', 'agent.handoff': 'Atendimento transferido ao humano' } as Record<string, string>)[eventType] ?? eventType; }
function traceStatusLabel(status: OperationTrace['status']) { return ({ received: 'Recebido', queued: 'Na fila', running: 'Processando', completed: 'Concluído', failed: 'Falhou', skipped: 'Ignorado' } as Record<OperationTrace['status'], string>)[status]; }
function traceDetail(trace: OperationTrace) { const detail = trace.detail ?? {}; if (detail.result === 'waiting_configuration') return 'Aguardando ativação do provedor de IA'; if (typeof detail.reason === 'string') return `Motivo: ${detail.reason}`; if (typeof detail.tool === 'string') return `Ferramenta: ${detail.tool}`; if (typeof detail.delayMs === 'number') return `Janela de agrupamento: ${Math.round(detail.delayMs / 1000)} s`; if (typeof detail.messageType === 'string') return `Mensagem ${detail.messageType}`; if (typeof detail.inputMessages === 'number') return `${detail.inputMessages} mensagem(ns) analisada(s)`; return 'Evento registrado pela operação'; }

function Empty({ title, text }: { title: string; text: string }) { return <div className="empty"><span>⌁</span><strong>{title}</strong><p>{text}</p></div>; }
