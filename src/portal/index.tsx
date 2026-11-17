/** Standalone operator and personal-tenant webpages; no DSH management code or credentials enter the tenant bundle. */
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { PersonalSpace, PersonalTask, PersonalView, RegistrationView } from '../app/portal-types.ts'
import css from './portal.css?raw'

const style = document.createElement('style'); style.textContent = css; document.head.append(style)
const boot = JSON.parse(document.getElementById('portal-boot')!.textContent!) as { mode: 'admin' | 'tenant'; id?: string }
const ADMIN = '/orchestrator/registration/api/members'
const phaseNames: Record<string, string> = { creating: '正在生成二维码', waiting: '等待微信扫码', scanned: '已扫码，请在微信中确认',
  needs_pin: '微信需要验证 PIN', saving: '正在关联个人空间', bound: '微信已绑定', expired: '二维码已过期', failed: '绑定未完成', cancelled: '绑定已取消' }
const stages: Record<string, string> = { queued: '排队中', working: '执行中', person: '等待确认', idle: '等待继续', ended: '已结束' }
/** Browser-visible failure carrying only a safe message and HTTP status. */
class ApiFailure extends Error { constructor(readonly status: number, message: string) { super(message) } }
async function request<T>(path: string, method = 'GET', body?: unknown, admin = false): Promise<T> {
  const response = await fetch(path, { method, credentials: 'same-origin', headers: { [admin ? 'x-orchestrator-request' : 'x-conest-request']: '1',
    ...body === undefined ? {} : { 'content-type': 'application/json' } }, ...body === undefined ? {} : { body: JSON.stringify(body) } })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) throw new ApiFailure(response.status, result.error || '暂时无法连接，请稍后重试')
  return result as T
}
function useData<T>(load: () => Promise<T>, enabled = true) {
  const [data, setData] = useState<T>(), [error, setError] = useState<Error>()
  const reload = useCallback(async () => { try { const value = await load(); setData(value); setError(undefined) } catch (error) { setError(error as Error) } }, [load])
  useEffect(() => { if (!enabled) return; void reload(); const timer = setInterval(() => { if (!document.hidden) void reload() }, 1500); return () => clearInterval(timer) }, [reload, enabled])
  return { data, error, reload }
}
function Brand() { return <div className="brand"><span className="brand-mark" aria-hidden>◉</span><span>CoNest<small>共栖 · 私有智能空间</small></span></div> }
function Notice({ text }: { text?: string }) { return text ? <div className="notice" role="status">{text}</div> : null }
function Modal({ title, close, children }: { title: string; close: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => { ref.current!.showModal() }, [])
  return <dialog ref={ref} className="modal" aria-label={title} onCancel={event => { event.preventDefault(); close() }}
    onClick={event => { if (event.target === event.currentTarget) { const box = event.currentTarget.getBoundingClientRect();
      if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) close() } }}>{children}</dialog>
}
function Status({ member }: { member: PersonalSpace }) {
  return <span className={`status ${member.status === 'disabled' ? 'muted' : member.bound ? 'success' : 'pending'}`}>
    <i />{member.status === 'disabled' ? '已停用' : member.bound ? '微信已绑定' : phaseNames[member.binding?.phase ?? ''] ?? '等待绑定'}</span>
}
function Binding({ member, admin, perform }: { member: PersonalSpace; admin: boolean; perform: (action: string, body?: unknown) => Promise<void> }) {
  const [pin, setPin] = useState(''), [busy, setBusy] = useState(false)
  const binding = member.binding, phase = binding?.phase
  async function run(action: string, body?: unknown) { setBusy(true); try { await perform(action, body) } finally { setBusy(false) } }
  const pinSubmit = (event: FormEvent) => { event.preventDefault(); void run('pin', { attempt: binding!.id, pin }).then(() => setPin('')) }
  return <section className="binding-card">
    <div className="section-heading"><div><span className="eyebrow">WECHAT CONNECTION</span><h2>连接微信</h2></div><Status member={member} /></div>
    {member.status === 'disabled' ? <div className="empty">此个人空间已停用。</div> : member.bound && (!binding || binding.phase === 'bound')
      ? <div className="connected"><span className="connected-icon">✓</span><h3>微信与个人空间已关联</h3><p>可以在机器人私聊中发送任务，结果会回到你的微信。</p>
        {admin && <button className="secondary" disabled={busy} onClick={() => void run('binding')}>重新授权微信</button>}</div>
      : <div className="binding-content"><div className="qr-box">{binding?.qr ? <img src={binding.qr} alt={`${member.displayName}的微信绑定二维码`} />
        : <div className="qr-placeholder" role="status"><span>▦</span>{phaseNames[phase ?? ''] ?? '等待生成二维码'}</div>}</div>
        <div className="binding-instructions"><h3>{phaseNames[phase ?? ''] ?? '扫码连接你的微信'}</h3>
          <p>请使用本人微信扫码，并在微信中确认授权。完成后会自动关联当前个人空间，无需导出文件。</p>
          {binding?.error && <p className="error" role="alert">{binding.error}</p>}
          {phase === 'needs_pin' && <form onSubmit={pinSubmit} className="pin-form"><label htmlFor={`pin-${member.id}`}>微信显示的 PIN</label>
            <input id={`pin-${member.id}`} inputMode="numeric" autoComplete="off" pattern="[0-9]{4,16}" required maxLength={16} value={pin} onChange={event => setPin(event.target.value)} />
            <button disabled={busy}>验证并继续</button></form>}
          {(!binding || ['failed', 'expired', 'cancelled'].includes(phase!)) && <button disabled={busy} onClick={() => void run('binding')}>生成新的二维码</button>}
          {binding && !['bound', 'failed', 'expired', 'cancelled'].includes(phase!) && <p className="hint">此二维码仅用于当前成员，过期后可重新生成。</p>}
        </div></div>}
  </section>
}
function Admin() {
  const load = useCallback(() => request<RegistrationView>(ADMIN, 'GET', undefined, true), [])
  const { data, error, reload } = useData(load)
  const [selected, select] = useState<string>(), [name, setName] = useState(''), [creating, setCreating] = useState(false)
  const [invite, setInvite] = useState<{ id: string; url: string }>(), [notice, setNotice] = useState<string>(), [filter, setFilter] = useState('')
  const members = data?.members ?? [], member = members.find(item => item.id === selected) ?? members[0]
  async function create(event: FormEvent) {
    event.preventDefault(); setCreating(true); setNotice(undefined)
    try { const result = await request<{ member: PersonalSpace; inviteUrl?: string }>(ADMIN, 'POST', { displayName: name }, true)
      select(result.member.id); setInvite(result.inviteUrl ? { id: result.member.id, url: result.inviteUrl } : undefined); setName(''); await reload()
      setNotice('个人空间已创建，请让对应成员完成微信扫码。')
    } catch (error) { setNotice((error as Error).message) } finally { setCreating(false) }
  }
  async function perform(action: string, body?: unknown) {
    if (!member) return
    try { const result = await request<{ inviteUrl?: string }>(`${ADMIN}/${member.id}/${action}`, 'POST', body, true)
      if (result.inviteUrl) setInvite({ id: member.id, url: result.inviteUrl }); await reload()
    } catch (error) { setNotice((error as Error).message) }
  }
  async function copy() {
    if (!invite) return
    try { await navigator.clipboard.writeText(invite.url); setNotice('个人访问链接已复制，请私下交给对应成员。') }
    catch { setNotice('请选中下方链接手动复制。') }
  }
  return <div className="shell"><aside className="sidebar"><Brand /><div className="nav-label">平台管理</div><div className="nav-item active">◇　成员与微信</div>
    <div className="sidebar-note">每位成员一个独立空间<br />身份、工单与结果分别保存</div></aside><main className="main">
    <div className="topline"><span>管理工作台 / 成员</span><span className="pill">管理员</span></div>
    <header className="hero"><span className="eyebrow">A SPACE FOR EVERYONE</span><h1>让每位成员拥有自己的空间</h1><p>创建成员，扫码连接微信。个人任务和结果只对本人可见。</p></header>
    <Notice text={notice || error?.message} />
    {error instanceof ApiFailure && error.status === 401 && <p><a href="/">先登录 DSH 管理端</a></p>}
    <div className="admin-grid"><section className="directory"><div className="section-heading"><h2>成员 <span className="count">{members.length}</span></h2></div>
      <form className="create-form" onSubmit={create}><label htmlFor="member-name">创建新成员</label><div className="inline-form"><input id="member-name" placeholder="输入成员名称" maxLength={100} required value={name} onChange={event => setName(event.target.value)} />
        <button disabled={creating}>{creating ? '创建中…' : '创建'}</button></div></form>
      {members.length > 5 && <input aria-label="搜索成员" placeholder="搜索成员" value={filter} onChange={event => setFilter(event.target.value)} />}
      <div className="member-list">{members.filter(item => item.displayName.includes(filter)).map(item => <button className={`member-row ${member?.id === item.id ? 'selected' : ''}`} key={item.id} onClick={() => { select(item.id); setNotice(undefined) }}>
        <span className="avatar">{item.displayName.slice(0, 1)}</span><span className="member-label"><strong>{item.displayName}</strong><Status member={item} /></span><span>›</span></button>)}</div>
      {!members.length && <div className="empty">创建第一位成员后，<br />这里将显示其微信绑定进度。</div>}</section>
      <div className="workspace">{member ? <><div className="member-heading"><div><h2>{member.displayName}的个人空间</h2><p>仅属于这位成员的微信连接与任务入口</p></div>
        <button className="text-button" onClick={() => void perform('status', { status: member.status === 'active' ? 'disabled' : 'active' })}>{member.status === 'active' ? '停用成员' : '启用成员'}</button></div>
        <Binding key={member.id} member={member} admin perform={perform} />
        <section className="access-card"><span className="eyebrow">PERSONAL ACCESS</span><h2>交付个人入口</h2><p>二维码负责连接微信；个人访问链接用于登录网页、查看和处理自己的任务。</p>
          {invite?.id === member.id ? <><label htmlFor="invite-url">一次性个人访问链接</label><textarea id="invite-url" readOnly value={invite.url} rows={3} />
            <div className="button-row"><button onClick={() => void copy()}>复制个人访问链接</button><a className="secondary link-button" href={invite.url} target="_blank" rel="noopener noreferrer">打开个人空间 ↗</a></div>
            <p className="hint">链接一天内有效且只能使用一次。请只交给对应成员。</p></>
            : <button className="secondary" disabled={member.status === 'disabled' || !data?.portalOrigin} onClick={() => void perform('invite')}>生成个人访问链接</button>}
        </section></> : <section className="welcome"><span>✦</span><h2>从一位成员开始</h2><p>创建后会自动生成微信二维码和个人入口。</p></section>}</div></div>
    <footer>CoNest · 每个人都有自己的空间</footer></main></div>
}
function Tenant() {
  const id = boot.id!, base = `/t/${id}/api`
  const [ready, setReady] = useState(false), [loginError, setLoginError] = useState<string>(), [notice, setNotice] = useState<string>()
  const [tab, setTab] = useState<'tasks' | 'wechat'>('tasks'), [offset, setOffset] = useState(0), [text, setText] = useState(''), [busy, setBusy] = useState(false)
  const [selectedTask, setOpened] = useState<PersonalTask>(), [answer, setAnswer] = useState('')
  useEffect(() => {
    const invite = new URLSearchParams(location.hash.slice(1)).get('invite'); history.replaceState(null, '', location.pathname)
    void (async () => { try {
      if (invite) await request(`${base}/exchange`, 'POST', { invite })
      await request(`${base}/state`); setReady(true)
    } catch (error) { setLoginError((error as Error).message) } })()
  }, [base])
  const load = useCallback(() => request<PersonalView>(`${base}/state?offset=${offset}`), [base, offset])
  const { data, error, reload } = useData(load, ready)
  const opened = selectedTask && (data?.tasks.find(task => task.id === selectedTask.id) ?? selectedTask)
  async function perform(action: string, body?: unknown) { try { await request(`${base}/${action}`, 'POST', body); await reload() } catch (error) { setNotice((error as Error).message) } }
  async function submit(event: FormEvent, ticketId?: string) {
    event.preventDefault(); setBusy(true)
    try { await request(`${base}/tasks`, 'POST', { requestId: crypto.randomUUID(), text: ticketId ? answer : text, ...ticketId ? { ticketId } : {} })
      if (ticketId) { setAnswer(''); setOpened(undefined) } else setText('')
      setNotice(ticketId ? '回复已送到原工单。' : '任务已收到，正在安排处理。'); setOffset(0); await reload()
    } catch (error) { setNotice((error as Error).message) } finally { setBusy(false) }
  }
  if (!ready || !data || error instanceof ApiFailure && error.status === 401) return <div className="login-shell"><Brand /><section className="login-card"><span className="eyebrow">YOUR PERSONAL SPACE</span>
    <h1>{loginError || error ? '需要个人访问链接' : '正在打开你的空间'}</h1><p>{loginError || error?.message || '正在安全连接，请稍候…'}</p>
    {(loginError || error) && <p className="hint">请向管理员索取新的个人访问链接。无需填写微信密码。</p>}</section></div>
  const member = data.member
  return <div className="shell"><aside className="sidebar"><Brand /><div className="profile"><span className="avatar large">{member.displayName.slice(0, 1)}</span><strong>{member.displayName}</strong><span>我的个人空间</span></div>
    <button className={`nav-item ${tab === 'tasks' ? 'active' : ''}`} onClick={() => setTab('tasks')}>▤　我的任务</button><button className={`nav-item ${tab === 'wechat' ? 'active' : ''}`} onClick={() => setTab('wechat')}>◇　微信连接</button>
    <button className="logout" onClick={() => void request(`${base}/logout`, 'POST').then(() => location.reload())}>退出个人空间</button></aside><main className="main">
    <div className="topline"><span>个人空间 / {tab === 'tasks' ? '我的任务' : '微信连接'}</span><span className="pill">仅本人可见</span></div>
    <header className="hero"><span className="eyebrow">YOUR SPACE, YOUR PACE</span><h1>{tab === 'tasks' ? `你好，${member.displayName}` : '让微信连接你的空间'}</h1><p>{tab === 'tasks' ? '把需要处理的事情交给 CoNest，在这里查看进度与结果。' : '扫码后即可在机器人私聊中发送任务。'}</p></header>
    <Notice text={notice || error?.message} />
    {tab === 'wechat' ? <Binding member={member} admin={false} perform={perform} /> : <>
      <div className="stats"><div><span>我的任务</span><strong>{data.total}</strong></div><div><span>微信连接</span><strong className="small-value">{member.bound ? '已绑定' : '待扫码'}</strong></div><div><span>执行方式</span><strong className="small-value">按队列处理</strong></div></div>
      {!member.bound && <div className="connect-banner"><div><strong>把微信也连接进来</strong><p>网页和微信中的任务属于同一个个人空间。</p></div><button className="secondary" onClick={() => setTab('wechat')}>去扫码绑定</button></div>}
      <section className="composer"><h2>新任务</h2><form onSubmit={event => void submit(event)}><label className="sr-only" htmlFor="new-task">描述需要处理的事情</label><textarea id="new-task" placeholder="例如：帮我整理明天出行前的准备清单…" required maxLength={8000} value={text} onChange={event => setText(event.target.value)} rows={3} />
        <div className="composer-footer"><span>任务和结果只对你可见</span><button disabled={busy}>{busy ? '提交中…' : '提交任务 →'}</button></div></form></section>
      <section className="task-section"><div className="section-heading"><h2>任务记录</h2><span className="hint">自动更新</span></div>
        {!data.tasks.length && <div className="empty">还没有任务。写下第一件想交给 CoNest 的事吧。</div>}
        {data.tasks.map(task => <article className="task-row" key={task.id}><div className="task-main"><span className={`task-stage stage-${task.stage}`}>{task.ended === 'completed' ? '已完成' : stages[task.stage]}</span>
          <h3>{task.title}</h3><p>{task.question || task.summary.slice(0, 150) || '已加入处理队列'}</p><time>{new Date(task.createdAt).toLocaleString('zh-CN')}</time></div>
          <button className="secondary" onClick={() => { setOpened(task); setAnswer('') }}>{task.question ? '回复问题' : task.ended ? '查看结果' : '查看进度'}</button></article>)}
        <div className="pagination"><button className="text-button" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 20))}>上一页</button><span>{data.total ? offset + 1 : 0}–{Math.min(offset + 20, data.total)} / {data.total}</span>
          <button className="text-button" disabled={data.nextOffset === null} onClick={() => setOffset(data.nextOffset!)}>下一页</button></div>
      </section></>}
    <footer>这是你的独立空间，其他成员无法查看这里的任务。</footer></main>
    {opened && <Modal title={opened.title} close={() => setOpened(undefined)}>
      <div className="section-heading"><h2>{opened.title}</h2><button className="text-button" aria-label="关闭" onClick={() => setOpened(undefined)}>✕</button></div>
      <div className="result-text">{opened.summary || '任务正在处理中。'}</div>
      {opened.question && <form onSubmit={event => void submit(event, opened.id)}><label htmlFor="answer">{opened.question}</label><textarea id="answer" value={answer} onChange={event => setAnswer(event.target.value)} required maxLength={8000} rows={3} /><button disabled={busy}>发送回复</button></form>}
      <div className="button-row">{opened.canRetry && <button className="secondary" onClick={() => void perform(`tasks/${opened.id}/retry`).then(() => setOpened(undefined))}>重试任务</button>}
        {opened.canStop && <button className="text-button danger" onClick={() => void perform(`tasks/${opened.id}/stop`).then(() => setOpened(undefined))}>停止任务</button>}</div>
    </Modal>}
  </div>
}
createRoot(document.getElementById('root')!).render(boot.mode === 'admin' ? <Admin /> : <Tenant />)
