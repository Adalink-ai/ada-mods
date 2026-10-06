import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { BATCH_MAX, METADATA_MAX_BYTES, SESSION_CAP_MS, guardRuleIds, safeMetadata } from '../hooks/governance'

// Tudo contra mocks: o backend (PR-A) e a flag auth.device-flow-cli podem nao existir ainda.
const BASE = 'https://adalink-api-gateway.onrender.com'
const T0 = Date.parse('2026-10-06T12:00:00Z')
const SESSION_TOKEN = 'sess_tok_123'

const jwtFor = (exp: number, claims: Record<string, unknown> = {}) => {
  const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
  return `${b64({ alg: 'EdDSA' })}.${b64({ exp: Math.floor(exp / 1000), ...claims })}.sig`
}

type Req = { url: string; method: string; headers: Record<string, string>; body: string; at: number }
type Reply = { status: number; body?: unknown } | (() => { status: number; body?: unknown }) | 'network-error'

// O mundo abaixo do plugin: rede (rotas com respostas em fila), store, relogio, avisos.
const world = (on: On, opts: { store?: Record<string, unknown>; now?: number } = {}) => {
  const clock = mock.clock(on, { now: opts.now ?? T0 })
  const store: Record<string, unknown> = { ...(opts.store ?? {}) }
  const requests: Req[] = []
  const routes: Record<string, Reply[]> = {}
  const toasts: string[] = []
  const opened: string[][] = []
  const reply = (key: string, ...r: Reply[]) => {
    ;(routes[key] ??= []).push(...r)
  }
  const replace = (key: string, ...r: Reply[]) => {
    routes[key] = r
  }
  on('store.get', (_$, e) => ({ value: store[e.key] }) as never)
  on('store.set', (_$, e) => {
    store[e.key] = JSON.parse(JSON.stringify(e.value))
    return { value: undefined } as never
  })
  on('store.delete', (_$, e) => {
    delete store[e.key]
    return { value: undefined } as never
  })
  on('http.fetch', (_$, e) => {
    const method = e.init?.method ?? 'GET'
    const path = new URL(e.url).pathname
    requests.push({ url: e.url, method, headers: { ...(e.init?.headers ?? {}) }, body: e.init?.body ?? '', at: clock.now() })
    const queue = routes[`${method} ${path}`] ?? []
    const r = queue.length > 1 ? queue.shift()! : queue[0]
    if (r === undefined) return { value: { status: 404, ok: false, headers: {}, text: '{}' } } as never
    if (r === 'network-error') throw new Error('ECONNREFUSED')
    const { status, body } = typeof r === 'function' ? r() : r
    return { value: { status, ok: status >= 200 && status < 300, headers: {}, text: JSON.stringify(body ?? {}) } } as never
  })
  on('ui.toast', (_$, e) => {
    toasts.push(String((e as { text?: string }).text ?? ''))
    return { value: undefined } as never
  })
  on('ui.log', () => ({ value: undefined }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('process.run', (_$, e) => {
    opened.push([...e.argv])
    const stdout = e.argv[0] === 'uname' ? 'Darwin\n' : ''
    return { value: { exitCode: 0, stdout, stderr: '' } } as never
  })
  on('session.id', () => ({ value: '3f1c2b9e-0000-4000-8000-000000000001' }) as never)
  on('session.version', () => ({ value: { version: '2.1.292', base: '2.1.292' } }) as never)
  on('command.register', (_$, e) => ({ value: { command: e.name } }) as never)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.end', () => ({ sessionId: 'x' }) as never)
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  return { clock, store, requests, reply, replace, toasts, opened }
}

const loggedIn = (createdAt = T0 - 60_000) => ({
  session: {
    token: SESSION_TOKEN,
    baseUrl: BASE,
    createdAt,
    loggedInAt: createdAt,
    organizationId: 'org-1',
    organizationName: 'Acme',
    userEmail: 'dev@acme.com',
  },
})

const start = ($: any, isInteractive = false) => $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive })
const run = async ($: any, args: string) => (await $.command.run({ command: 'adaflow', args })).text as string
const batches = (w: { requests: Req[] }) =>
  w.requests.filter(r => r.url.endsWith('/v1/audit/events/batch')).map(r => JSON.parse(r.body).events as any[])

const DEVICE_CODE = {
  status: 200,
  body: {
    device_code: 'dev-code-secret',
    user_code: 'WDJB-MJHT',
    verification_uri: 'https://app.adalink.ai/cli',
    verification_uri_complete: 'https://app.adalink.ai/cli?user_code=WDJB-MJHT',
    expires_in: 600,
    interval: 5,
  },
}
const pending = { status: 400, body: { error: 'authorization_pending' } }
const tokenOk = () => ({ status: 200, body: { token: jwtFor(T0 + 15 * 60_000, { organizationName: 'Acme' }) } })

// ---------- device flow ----------

test('login: pede o codigo, mostra codigo e link, respeita interval e slow_down, guarda o token', async ($, on) => {
  const w = world(on)
  w.reply('POST /v1/auth/device/code', DEVICE_CODE)
  w.reply('POST /v1/auth/device/token', pending, { status: 400, body: { error: 'slow_down' } }, pending, {
    status: 200,
    body: { access_token: SESSION_TOKEN, token_type: 'Bearer', expires_in: 604800 },
  })
  w.reply('GET /v1/auth/get-session', {
    status: 200,
    body: { session: { createdAt: new Date(T0).toISOString(), activeOrganizationId: 'org-1' }, user: { email: 'dev@acme.com' } },
  })
  w.reply('GET /v1/auth/token', tokenOk)
  await start($, true)

  const text = await run($, 'login')
  expect(text).toContain('WDJB-MJHT')
  expect(text).toContain('https://app.adalink.ai/cli?user_code=WDJB-MJHT')
  const code = w.requests.find(r => r.url === `${BASE}/v1/auth/device/code`)!
  expect(code.method).toBe('POST')
  expect(JSON.parse(code.body)).toEqual({ client_id: 'claude-code', scope: 'audit.ingest' })
  // macOS: tenta abrir o navegador (sem esperar por isso)
  await w.clock.settle()
  expect(w.opened).toContainEqual(['open', 'https://app.adalink.ai/cli?user_code=WDJB-MJHT'])

  // faixa acima do prompt com o link clicavel
  const ui = await $.ui.mount({ plugin: 'adaflow-governance', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false } as never })
  const link = await ui.find({ type: 'Link' })
  expect(link).toBeDefined()
  expect(JSON.stringify(await ui.drawn())).toContain('"href":"https://app.adalink.ai/cli?user_code=WDJB-MJHT"')
  expect(JSON.stringify(await ui.drawn())).toContain('WDJB-MJHT')
  await ui.unmount()

  await w.clock.advance(4_999)
  expect(w.requests.filter(r => r.url.endsWith('/device/token')).length).toBe(0)
  await w.clock.advance(1) // 5 s: pending
  await w.clock.advance(5_000) // 10 s: slow_down -> intervalo vira 10 s
  await w.clock.advance(5_000) // 15 s: nada
  expect(w.requests.filter(r => r.url.endsWith('/device/token')).length).toBe(2)
  await w.clock.advance(5_000) // 20 s: pending
  await w.clock.advance(10_000) // 30 s: aprovado
  const polls = w.requests.filter(r => r.url.endsWith('/device/token'))
  expect(polls.map(p => p.at - T0)).toEqual([5_000, 10_000, 20_000, 30_000])
  expect(JSON.parse(polls[0]!.body)).toEqual({
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    device_code: 'dev-code-secret',
    client_id: 'claude-code',
  })

  expect((w.store.session as any).token).toBe(SESSION_TOKEN)
  expect((w.store.session as any).organizationName).toBe('Acme')
  expect(w.toasts.join(' ')).toContain('conectado (Acme)')
  const tokenReq = w.requests.find(r => r.url.endsWith('/v1/auth/token'))!
  expect(tokenReq.headers.authorization).toBe(`Bearer ${SESSION_TOKEN}`)

  const status = await run($, 'status')
  expect(status).toContain('Acme')
  expect(status).toContain('6 d 23 h') // 7 d - 30 s
})

test('login: Cancelar na faixa para a consulta e some com a faixa', async ($, on) => {
  const w = world(on)
  // sem login pendente o mod passa a vez: quem desenha e o que estiver abaixo (aqui, o teste)
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Text', children: ['engine'] }) as never)
  w.reply('POST /v1/auth/device/code', DEVICE_CODE)
  w.reply('POST /v1/auth/device/token', pending)
  await start($)
  await run($, 'login')
  const props = { hasSurvey: false, isWorking: false } as never
  const ui = await $.ui.mount({ plugin: 'adaflow-governance', surface: 'terminal', component: 'AbovePrompt', props })
  await ui.press({ key: 'cancel' })
  await ui.unmount()
  await w.clock.advance(30_000)
  expect(w.requests.filter(r => r.url.endsWith('/device/token')).length).toBe(0)
  expect(w.toasts.join(' ')).toContain('cancelado')
  const again = await $.ui.mount({ plugin: 'adaflow-governance', surface: 'terminal', component: 'AbovePrompt', props })
  expect(await again.find({ type: 'Link' })).toBeUndefined()
  expect(JSON.stringify(await again.drawn())).toContain('engine')
  await again.unmount()
})

test('login: expired_token encerra a espera e avisa', async ($, on) => {
  const w = world(on)
  w.reply('POST /v1/auth/device/code', DEVICE_CODE)
  w.reply('POST /v1/auth/device/token', { status: 400, body: { error: 'expired_token' } })
  await start($)
  await run($, 'login')
  await w.clock.advance(5_000)
  expect(w.toasts.join(' ')).toContain('expirou')
  await w.clock.advance(60_000)
  expect(w.requests.filter(r => r.url.endsWith('/device/token')).length).toBe(1)
  expect(w.store.session).toBeUndefined()
  expect(await run($, 'status')).toContain('nao conectado')
})

test('login: access_denied encerra a espera e avisa', async ($, on) => {
  const w = world(on)
  w.reply('POST /v1/auth/device/code', DEVICE_CODE)
  w.reply('POST /v1/auth/device/token', { status: 400, body: { error: 'access_denied' } })
  await start($)
  await run($, 'login')
  await w.clock.advance(5_000)
  expect(w.toasts.join(' ')).toContain('negado')
  await w.clock.advance(60_000)
  expect(w.requests.filter(r => r.url.endsWith('/device/token')).length).toBe(1)
  expect(w.store.session).toBeUndefined()
})

test('login: codigo vencido localmente para de consultar', async ($, on) => {
  const w = world(on)
  w.reply('POST /v1/auth/device/code', { status: 200, body: { ...DEVICE_CODE.body, expires_in: 12 } })
  w.reply('POST /v1/auth/device/token', pending)
  await start($)
  await run($, 'login')
  await w.clock.advance(60_000)
  expect(w.requests.filter(r => r.url.endsWith('/device/token')).length).toBe(2)
  expect(w.toasts.join(' ')).toContain('expirou')
})

test('login: flag desligada (404) e rede fora respondem sem travar', async ($, on) => {
  const w = world(on)
  w.reply('POST /v1/auth/device/code', { status: 404 })
  await start($)
  expect(await run($, 'login')).toContain('auth.device-flow-cli')
  w.replace('POST /v1/auth/device/code', 'network-error')
  expect(await run($, 'login')).toContain('Nao foi possivel contatar')
})

test('login: baseUrl http fora de localhost e recusada', { options: { baseUrl: 'http://gateway.example.com' } }, async ($, on) => {
  const w = world(on)
  await start($)
  expect(await run($, 'login')).toContain('invalida')
  expect(w.requests.length).toBe(0)
})

// ---------- logout / status ----------

test('logout: encerra no servidor com o session token e apaga token e fila', async ($, on) => {
  const w = world(on, { store: loggedIn() })
  w.reply('POST /v1/auth/sign-out', { status: 200, body: { success: true } })
  await start($)
  expect(w.store.queue).toBeDefined()
  const text = await run($, 'logout')
  expect(text).toContain('Desconectado')
  const signOut = w.requests.find(r => r.url === `${BASE}/v1/auth/sign-out`)!
  expect(signOut.method).toBe('POST')
  expect(signOut.headers.authorization).toBe(`Bearer ${SESSION_TOKEN}`)
  expect(w.store.session).toBeUndefined()
  expect(w.store.queue).toBeUndefined()
})

test('logout: servidor fora do ar ainda apaga o token local', async ($, on) => {
  const w = world(on, { store: loggedIn() })
  w.reply('POST /v1/auth/sign-out', 'network-error')
  await start($)
  expect(await run($, 'logout')).toContain('revogue')
  expect(w.store.session).toBeUndefined()
})

test('status: org, validade ate o teto, ultimo envio e fila', async ($, on) => {
  const w = world(on, { store: { ...loggedIn(T0 - 2 * 24 * 3600_000), queue: [], lastSentAt: T0 - 3600_000 } })
  w.reply('GET /v1/auth/token', 'network-error')
  w.reply('POST /v1/audit/events/batch', 'network-error')
  await start($)
  const text = await run($, 'status')
  expect(text).toContain('Acme')
  expect(text).toContain('5 d 0 h')
  expect(text).toContain('1 h')
  expect(text).toContain('Fila pendente: 1') // o session.start desta sessao
})

// ---------- eventos ----------

test('sem login: nenhum evento e nenhuma requisicao', async ($, on) => {
  const w = world(on)
  on('tool.call', () => ({ deny: 'adaflow-guard (token-print): nao' }))
  await start($)
  await $.turn.complete({ answer: 'x', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
  await $.tool.call({ tool: 'Bash', command: 'echo $ADAFLOW_APP_TOKEN' })
  await w.clock.advance(60_000)
  expect(w.requests.length).toBe(0)
  expect(w.toasts.length).toBe(0)
  expect(w.store.queue).toBeUndefined()
})

test('enabled=false: logado, mas nada e coletado nem enviado', { options: { enabled: false } }, async ($, on) => {
  const w = world(on, { store: loggedIn() })
  await start($)
  await $.turn.complete({ answer: 'x', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
  await w.clock.advance(60_000)
  expect(w.requests.length).toBe(0)
})

const SECRETS = ['PROMPT_SECRETO_42', 'RESPOSTA_SECRETA_42', 'CODIGO_SECRETO_42', 'SAIDA_SECRETA_42', '/Users/fulano/projeto-secreto']

test('lote: shape do DTO, so metadados, Bearer JWT e nenhum texto de prompt/codigo/saida', async ($, on) => {
  const w = world(on, { store: loggedIn() })
  w.reply('GET /v1/auth/token', tokenOk)
  w.reply('POST /v1/audit/events/batch', { status: 202, body: { accepted: 3, duplicated: 0, rejected: [] } })
  // abaixo do mod: o adaflow-guard (ou quem for) recusa o Write; o Bash roda e devolve saida
  on('tool.call', (_$, e) =>
    e.tool === 'Write'
      ? { deny: `adaflow-guard (token-in-client, literal-token) em ${SECRETS[4]}: CODIGO_SECRETO_42` }
      : { result: {} as never, text: 'SAIDA_SECRETA_42' },
  )
  await start($)
  await $.prompt.submit({ text: 'PROMPT_SECRETO_42' } as never).catch(() => undefined)
  await $.tool.call({ tool: 'Write', file_path: `${SECRETS[4]}/a.tsx`, content: "'use client'\nCODIGO_SECRETO_42" })
  await $.tool.call({ tool: 'Bash', command: 'cat PROMPT_SECRETO_42' })
  await $.turn.complete({
    answer: 'RESPOSTA_SECRETA_42 com CODIGO_SECRETO_42',
    durationMs: 4321,
    isAborted: false,
    turnId: 'turn-1',
    reason: 'answer',
    usage: { model: 'claude-opus-5-5', input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 },
  })
  await w.clock.advance(15_000)

  const sent = batches(w)
  // o session.start sai no envio do inicio da sessao; o resto, juntos, no tick seguinte
  expect(sent.map(b => b.length)).toEqual([1, 2])
  const events = sent.flat()
  expect(events.map(ev => ev.action)).toEqual([
    'app.claude_code.session.start',
    'app.claude_code.tool.denied',
    'app.claude_code.turn.complete',
  ])
  for (const ev of events) {
    expect(ev.app).toBe('claude-code')
    expect(ev.action).toMatch(/^app\.[a-z0-9_-]+(\.[a-z0-9_-]+){1,4}$/)
    expect(typeof ev.eventId).toBe('string')
    expect(ev.eventId.length <= 64).toBe(true)
    expect(ev.resource.length <= 100).toBe(true)
    expect(new TextEncoder().encode(JSON.stringify(ev.metadata)).length <= METADATA_MAX_BYTES).toBe(true)
    expect(Object.keys(ev).every(k => ['app', 'eventId', 'action', 'resource', 'actionLabel', 'severity', 'success', 'metadata', 'occurredAt'].includes(k))).toBe(true)
  }
  expect(events[1]!.metadata).toEqual({ sessionId: '3f1c2b9e-0000-4000-8000-000000000001', tool: 'Write', decision: 'deny', source: 'adaflow-guard', rules: ['token-in-client', 'literal-token'] })
  expect(events[1]!.success).toBe(false)
  expect(events[2]!.metadata).toMatchObject({ turnId: 'turn-1', model: 'claude-opus-5-5', durationMs: 4321, inputTokens: 10, outputTokens: 20 })

  for (const r of w.requests) {
    for (const s of SECRETS) expect(r.body.includes(s)).toBe(false)
    expect(Object.keys(r.headers).some(h => h.toLowerCase() === 'x-ada-token')).toBe(false)
  }
  const post = w.requests.find(r => r.url === `${BASE}/v1/audit/events/batch`)!
  expect(post.headers.authorization).toMatch(/^Bearer .+\..+\.sig$/)
  expect(w.store.queue).toEqual([])
  expect(await run($, 'status')).toContain('Fila pendente: 0')
})

test('tool.denied sem o adaflow-guard: so ferramenta e decisao', async ($, on) => {
  const w = world(on, { store: loggedIn() })
  w.reply('GET /v1/auth/token', tokenOk)
  w.reply('POST /v1/audit/events/batch', { status: 202, body: { accepted: 2, duplicated: 0, rejected: [] } })
  on('tool.call', () => ({ deny: 'politica X: comando CODIGO_SECRETO_42 bloqueado' }))
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'rm -rf CODIGO_SECRETO_42' })
  await w.clock.advance(15_000)
  const ev = batches(w).flat().find(e => e.action === 'app.claude_code.tool.denied')
  expect(ev.metadata).toEqual({ sessionId: '3f1c2b9e-0000-4000-8000-000000000001', tool: 'Bash', decision: 'deny', source: 'outro' })
})

test('lote de no maximo 50 e eventId estavel no reenvio', async ($, on) => {
  const w = world(on, { store: loggedIn() })
  w.reply('GET /v1/auth/token', tokenOk)
  w.reply('POST /v1/audit/events/batch', { status: 202, body: { accepted: 1 } }, { status: 503 }, { status: 202, body: { accepted: 50 } })
  await start($)
  await w.clock.settle()
  expect(batches(w).map(b => b.length)).toEqual([1]) // session.start
  for (let i = 0; i < 60; i++) {
    await $.turn.complete({ answer: '', durationMs: i, isAborted: false, turnId: `t${i}`, reason: 'answer' })
  }
  await w.clock.settle()
  // o 50o evento dispara um envio, que falha (503) e entra em backoff; os 10 seguintes esperam
  expect(batches(w).map(b => b.length)).toEqual([1, BATCH_MAX])
  const firstIds = batches(w)[1]!.map(e => e.eventId)
  await w.clock.advance(15_000)
  const all = batches(w)
  expect(all.map(b => b.length)).toEqual([1, BATCH_MAX, BATCH_MAX, 10])
  expect(all[2]!.map(e => e.eventId)).toEqual(firstIds)
  expect(w.store.queue).toEqual([])
})

test('falha de rede nunca bloqueia: turno e ferramenta seguem, fila fica com backoff', async ($, on) => {
  const w = world(on, { store: loggedIn() })
  w.reply('GET /v1/auth/token', 'network-error')
  on('tool.call', () => ({ result: {} as never, text: 'ok' }))
  await start($)
  const r = await $.turn.complete({ answer: 'fim', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
  expect(r.text).toBe('fim')
  const t = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(t.deny).toBeUndefined()
  await w.clock.advance(15_000)
  const tries = w.requests.filter(r => r.url.endsWith('/v1/auth/token')).length
  expect((w.store.queue as unknown[]).length).toBe(2)
  // backoff: 5 s, 10 s, 20 s ... a proxima tentativa nao acontece a cada tick
  await w.clock.advance(15_000)
  await w.clock.advance(15_000)
  const later = w.requests.filter(r => r.url.endsWith('/v1/auth/token')).length
  expect(later > tries).toBe(true)
  expect(later < tries + 3).toBe(true)
  expect(w.toasts.length).toBe(0)
})

test('JWT: reaproveita ate perto de expirar, renova antes dos 15 min e no 401', async ($, on) => {
  const w = world(on, { store: loggedIn() })
  let n = 0
  w.reply('GET /v1/auth/token', () => ({ status: 200, body: { token: jwtFor(w.clock.now() + 15 * 60_000, { n: ++n }) } }))
  w.reply(
    'POST /v1/audit/events/batch',
    { status: 202, body: { accepted: 1 } },
    { status: 202, body: { accepted: 1 } },
    { status: 401 },
    { status: 202, body: { accepted: 1 } },
  )
  await start($)
  await w.clock.advance(15_000) // envia session.start: token 1
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'a', reason: 'answer' })
  await w.clock.advance(15_000) // reaproveita token 1
  expect(w.requests.filter(r => r.url.endsWith('/v1/auth/token')).length).toBe(1)
  await w.clock.advance(14 * 60_000) // perto dos 15 min
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'b', reason: 'answer' })
  await w.clock.advance(15_000) // renova (token 2), depois 401 no lote -> renova (token 3) e reenvia
  expect(w.requests.filter(r => r.url.endsWith('/v1/auth/token')).length).toBe(3)
  const posts = w.requests.filter(r => r.url.endsWith('/batch'))
  expect(posts.length).toBe(4)
  expect(posts[2]!.body).toBe(posts[3]!.body)
  expect(posts[2]!.headers.authorization).not.toBe(posts[3]!.headers.authorization)
  expect(w.store.queue).toEqual([])
})

test('401 no refresh (revogada) avisa para /adaflow login, apaga o token e para de coletar', async ($, on) => {
  const w = world(on, { store: loggedIn() })
  w.reply('GET /v1/auth/token', { status: 401 })
  await start($)
  await w.clock.advance(15_000)
  expect(w.toasts.join(' ')).toContain('/adaflow login')
  expect(w.store.session).toBeUndefined()
  const before = w.requests.length
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'x', reason: 'answer' })
  await w.clock.advance(60_000)
  expect(w.requests.length).toBe(before)
  expect(w.toasts.length).toBe(1)
})

test('teto de 7 dias: sessao vencida nem pede JWT e avisa', async ($, on) => {
  const w = world(on, { store: loggedIn(T0 - SESSION_CAP_MS - 1) })
  w.reply('GET /v1/auth/token', tokenOk)
  await start($)
  await w.clock.advance(15_000)
  expect(w.requests.filter(r => r.url.endsWith('/v1/auth/token')).length).toBe(0)
  expect(w.toasts.join(' ')).toContain('7 dias')
  expect(w.store.session).toBeUndefined()
})

test('400/403 descartam o lote (reenviar nao muda), rejected parcial nao trava a fila', async ($, on) => {
  const w = world(on, { store: loggedIn() })
  w.reply('GET /v1/auth/token', tokenOk)
  w.reply('POST /v1/audit/events/batch', { status: 403, body: { code: 'scope_required' } }, { status: 202, body: { accepted: 0, duplicated: 0, rejected: [{ index: 0, reason: 'x' }] } })
  await start($)
  await w.clock.advance(15_000)
  expect(w.store.queue).toEqual([])
  expect(await run($, 'status')).toContain('HTTP 403')
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'x', reason: 'answer' })
  await w.clock.advance(15_000)
  expect(w.store.queue).toEqual([])
  expect(await run($, 'status')).toContain('rejeitado')
})

// ---------- unidades puras ----------

test('safeMetadata: so primitivos curtos e no maximo 4KB', () => {
  const m = safeMetadata({ ok: 1, b: true, longo: 'x'.repeat(500), obj: { a: 1 }, rules: ['a-b', 'NAO VALE', 'c'], 'chave invalida': 1 })
  expect(m).toEqual({ ok: 1, b: true, rules: ['a-b', 'c'] })
  const big: Record<string, unknown> = {}
  for (let i = 0; i < 100; i++) big[`k${i}`] = 'y'.repeat(100)
  expect(new TextEncoder().encode(JSON.stringify(safeMetadata(big))).length <= METADATA_MAX_BYTES).toBe(true)
})

test('guardRuleIds le os ids do motivo do adaflow-guard', () => {
  expect(guardRuleIds('adaflow-guard (token-print): este comando...')).toEqual(['token-print'])
  expect(guardRuleIds('adaflow-guard (token-in-client, browser-gateway) em /a.tsx: ...')).toEqual(['token-in-client', 'browser-gateway'])
  expect(guardRuleIds('outra coisa')).toBe(null)
})
