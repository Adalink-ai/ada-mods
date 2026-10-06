import type { HttpInit, HttpResponse } from 'claude-code'
import type { GovernanceLogin } from '../types'

// Nucleo do mod, sem `$`: todo efeito passa pela `Io` que o register.tsx monta com chamadas
// inline a `$`. Contrato: PRD login-cli-device-flow (adalink-platform/docs/prds), §3 e §4.5.

export const APP = 'claude-code'
export const CLIENT_ID = 'claude-code'
export const SCOPE = 'audit.ingest'
export const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'

export const SESSION_CAP_MS = 7 * 24 * 60 * 60 * 1000 // teto absoluto da sessao de CLI (D2)
export const JWT_FALLBACK_MS = 15 * 60 * 1000 // JWT sem `exp` legivel: 15 min (D4)
export const JWT_SKEW_MS = 60 * 1000 // renova 1 min antes de expirar
export const SLOW_DOWN_MS = 5000 // RFC 8628 §3.5
export const DEFAULT_INTERVAL_MS = 5000
export const DEFAULT_CODE_TTL_MS = 10 * 60 * 1000
export const BATCH_MAX = 50 // IngestAuditEventsBatchDto @ArrayMaxSize(50)
export const QUEUE_MAX = 500
export const METADATA_MAX_BYTES = 4096 // metadata: max. 4KB serializado
export const OCCURRED_MAX_AGE_MS = SESSION_CAP_MS - 60 * 60 * 1000 // occurredAt aceita ate -7 d
export const BACKOFF_MIN_MS = 5000
export const BACKOFF_MAX_MS = 5 * 60 * 1000
export const FLUSH_EVERY_MS = 15 * 1000
const HTTP_TIMEOUT_NOTE = 'falha de rede'

export const STORE_SESSION = 'session'
export const STORE_QUEUE = 'queue'
export const STORE_LAST_SENT = 'lastSentAt'

export type Io = {
  fetch: (url: string, init?: HttpInit) => Promise<HttpResponse>
  now: () => Promise<number>
  get: (key: string) => Promise<unknown>
  set: (key: string, value: unknown) => Promise<void>
  del: (key: string) => Promise<void>
  after: (ms: number, fn: () => void) => { cancel: () => void }
  toast: (text: string) => void
  log: (text: string) => void
  setLogin: (login: GovernanceLogin | null) => Promise<unknown>
  openUrl: (url: string) => Promise<void>
}

export type Config = { baseUrl: string; enabled: boolean }

// Sessao do CLI guardada em $.store: JSON em texto puro no diretorio de configuracao do
// Claude Code. Aceitavel so porque a credencial tem escopo `audit.ingest` (PRD D3, §4.1e).
export type StoredSession = {
  token: string
  baseUrl: string
  createdAt: number // createdAt da sessao no servidor (autoridade do teto de 7 d); senao, hora do login
  loggedInAt: number
  organizationId: string | null
  organizationName: string | null
  userEmail: string | null
}

// Shape exato de IngestAuditEventDto (security-service, origin/homolog).
export type IngestEvent = {
  app: string
  eventId: string
  action: string
  resource: string
  actionLabel?: string
  severity?: 'info' | 'warning' | 'critical'
  success?: boolean
  metadata?: Record<string, unknown>
  occurredAt?: string
}

export type EventKind = 'session.start' | 'turn.complete' | 'tool.denied'

const EVENTS: Record<EventKind, Pick<IngestEvent, 'action' | 'resource' | 'actionLabel' | 'severity'>> = {
  // `action` precisa casar com /^app\.[a-z0-9_-]+(\.[a-z0-9_-]+){1,4}$/ (namespace reservado
  // de apps). Os nomes do PRD (`claude_code.session.start`) nao passariam: vao com o prefixo `app.`.
  'session.start': {
    action: 'app.claude_code.session.start',
    resource: 'ClaudeCodeSession',
    actionLabel: 'Sessão do Claude Code iniciada',
    severity: 'info',
  },
  'turn.complete': {
    action: 'app.claude_code.turn.complete',
    resource: 'ClaudeCodeTurn',
    actionLabel: 'Turno do Claude Code concluído',
    severity: 'info',
  },
  'tool.denied': {
    action: 'app.claude_code.tool.denied',
    resource: 'ClaudeCodeTool',
    actionLabel: 'Ferramenta bloqueada no Claude Code',
    severity: 'warning',
  },
}

// ---------- utilitarios puros ----------

export const normalizeBaseUrl = (raw: string): string | null => {
  let url: URL
  try {
    url = new URL(String(raw).trim())
  } catch {
    return null
  }
  const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  // O token vai em Authorization: nunca em texto claro fora da maquina.
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocal)) return null
  return url.origin + url.pathname.replace(/\/+$/, '')
}

// Endereco digitado em `/adaflow login <endereco>`: aceita `cora.amcor.com` (sem esquema, vira https) ou uma
// URL completa. Vale so o origin: o login e a API ficam na raiz da plataforma da pessoa.
export const parseAddress = (raw: string): string | null => {
  const text = String(raw).trim()
  if (!text || /\s/.test(text)) return null
  const base = normalizeBaseUrl(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`)
  return base ? new URL(base).origin : null
}

// A pagina de aprovacao fica no endereco que a PESSOA escolheu (e onde o cookie de sessao dela vive), nunca
// no host que o servidor devolve: o servidor so informa o caminho (`/cli?user_code=...`).
export const onPlatform = (uri: string, base: string): string => {
  try {
    const u = new URL(uri, `${base}/`)
    return `${new URL(base).origin}${u.pathname}${u.search}`
  } catch {
    return uri
  }
}

const parseJson = (text: string): Record<string, unknown> => {
  try {
    const v = JSON.parse(text)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

export const decodeJwtPayload = (jwt: string): Record<string, unknown> => {
  const part = jwt.split('.')[1]
  if (!part) return {}
  try {
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/')
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
    const bytes = Uint8Array.from(bin, c => c.charCodeAt(0))
    return parseJson(new TextDecoder().decode(bytes))
  } catch {
    return {}
  }
}

// Erro do device flow: RFC 8628 usa { error }, o Better Auth as vezes { code }.
export const deviceError = (res: HttpResponse): string => {
  const body = parseJson(res.text)
  return String(body.error ?? body.code ?? '').toLowerCase()
}

const bytes = (s: string) => new TextEncoder().encode(s).length

// So primitivos curtos: o que nao for numero, booleano, texto curto ou lista de ids curtos fica
// de fora. Acima de 4KB, corta campos do fim ate caber.
export const safeMetadata = (raw: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(k)) continue
    if (typeof v === 'boolean') out[k] = v
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
    else if (typeof v === 'string' && v.length > 0 && v.length <= 120) out[k] = v
    else if (Array.isArray(v)) {
      const items = v.filter((x): x is string => typeof x === 'string' && /^[a-z0-9_-]{1,40}$/.test(x)).slice(0, 20)
      if (items.length > 0) out[k] = items
    }
  }
  const keys = Object.keys(out)
  while (keys.length > 0 && bytes(JSON.stringify(out)) > METADATA_MAX_BYTES) delete out[keys.pop()!]
  return out
}

// Ids de regra do adaflow-guard no motivo da recusa: "adaflow-guard (token-in-client, literal-token) em ...".
export const guardRuleIds = (deny: string): string[] | null => {
  const m = /^adaflow-guard \(([a-z0-9-]+(?:, [a-z0-9-]+)*)\)/.exec(deny)
  return m ? m[1]!.split(', ') : null
}

const fmtDuration = (ms: number): string => {
  if (ms <= 0) return 'expirada'
  const h = Math.floor(ms / 3_600_000)
  const d = Math.floor(h / 24)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  if (d > 0) return `${d} d ${h % 24} h`
  if (h > 0) return `${h} h ${m} min`
  return `${Math.max(1, m)} min`
}

const fmtAgo = (now: number, at: number | null): string =>
  at === null ? 'nenhum' : `há ${fmtDuration(Math.max(60_000, now - at))} (${new Date(at).toISOString()})`

// ---------- o mod ----------

type Pending = GovernanceLogin & { deviceCode: string; base: string; intervalMs: number; timer: { cancel: () => void } | null }

export class Governance {
  session: StoredSession | null = null
  queue: IngestEvent[] = []
  lastSentAt: number | null = null
  lastError: string | null = null
  sessionId: string | null = null
  private jwt: { token: string; exp: number } | null = null
  private pending: Pending | null = null
  private nextAttemptAt = 0
  private backoffMs = 0
  private flushing: Promise<void> | null = null
  private loaded = false

  constructor(
    private readonly io: Io,
    private readonly cfg: Config,
  ) {}

  get baseUrl() {
    return normalizeBaseUrl(this.cfg.baseUrl)
  }

  get isLoggedIn() {
    return this.session !== null
  }

  async load() {
    if (this.loaded) return
    this.loaded = true
    const s = (await this.io.get(STORE_SESSION).catch(() => undefined)) as StoredSession | undefined
    this.session = s && typeof s.token === 'string' ? s : null
    const q = await this.io.get(STORE_QUEUE).catch(() => undefined)
    this.queue = Array.isArray(q) ? (q as IngestEvent[]) : []
    const last = await this.io.get(STORE_LAST_SENT).catch(() => undefined)
    this.lastSentAt = num(last)
    // Um login pendente nao sobrevive a uma recarga do modulo (o device_code so existe na memoria).
    await this.io.setLogin(null).catch(() => undefined)
  }

  // ---------- login (device flow, RFC 8628) ----------

  async login(address?: string): Promise<string> {
    const typed = address?.trim()
    const base = typed ? parseAddress(typed) : this.baseUrl
    if (!base) {
      return `Endereco da plataforma invalido: \`${typed || this.cfg.baseUrl}\`. Use https (http so para localhost), por exemplo \`/adaflow login cora.amcor.com\`.`
    }
    const now = await this.io.now()
    if (this.session && now < this.session.createdAt + SESSION_CAP_MS) {
      return 'Ja conectado ao Adaflow. Rode `/adaflow status` para ver a sessao ou `/adaflow logout` para sair.'
    }
    if (this.pending && now < this.pending.expiresAt) {
      return `Login em andamento: confirme o codigo **${this.pending.userCode}** em ${this.pending.verificationUriComplete ?? this.pending.verificationUri}`
    }
    let res: HttpResponse
    try {
      res = await this.io.fetch(`${base}/v1/auth/device/code`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ client_id: CLIENT_ID, scope: SCOPE }),
      })
    } catch {
      return `Nao foi possivel contatar ${base} (${HTTP_TIMEOUT_NOTE}). Tente de novo em instantes.`
    }
    if (!res.ok) {
      if (res.status === 404 || res.status === 403) {
        return `O login do CLI ainda nao esta disponivel neste ambiente (HTTP ${res.status}; a flag \`auth.device-flow-cli\` pode estar desligada).`
      }
      return `A plataforma recusou o pedido de login (HTTP ${res.status}).`
    }
    const body = parseJson(res.text)
    const deviceCode = str(body.device_code)
    const userCode = str(body.user_code)
    const uri = str(body.verification_uri)
    if (!deviceCode || !userCode || !uri) return 'Resposta inesperada da plataforma ao pedir o codigo de login.'
    const login: Pending = {
      deviceCode,
      userCode,
      base,
      verificationUri: onPlatform(uri, base),
      verificationUriComplete: str(body.verification_uri_complete) ? onPlatform(String(body.verification_uri_complete), base) : null,
      expiresAt: now + (num(body.expires_in) ?? DEFAULT_CODE_TTL_MS / 1000) * 1000,
      intervalMs: Math.max(1, num(body.interval) ?? DEFAULT_INTERVAL_MS / 1000) * 1000,
      timer: null,
    }
    this.pending = login
    await this.io.setLogin(publicLogin(login)).catch(() => undefined)
    this.schedulePoll()
    const link = login.verificationUriComplete ?? login.verificationUri
    void this.io.openUrl(link).catch(() => undefined)
    return [
      '**Adaflow: login**',
      '',
      `1. Abra [${login.verificationUri}](${link})`,
      `2. Confirme o codigo **${userCode}** (ele precisa ser igual ao que aparece no navegador)`,
      '',
      `Aguardando a aprovacao (o codigo expira em ${fmtDuration(login.expiresAt - now)}). Pode seguir trabalhando: o resultado chega como aviso.`,
    ].join('\n')
  }

  cancelLogin(reason?: string) {
    const p = this.pending
    if (!p) return
    p.timer?.cancel()
    this.pending = null
    void this.io.setLogin(null).catch(() => undefined)
    if (reason) this.io.toast(reason)
  }

  private schedulePoll() {
    const p = this.pending
    if (!p) return
    p.timer = this.io.after(p.intervalMs, () => {
      void this.poll(p).catch(err => {
        this.io.log(`adaflow-governance: poll falhou: ${String(err)}`)
        if (this.pending === p) this.schedulePoll()
      })
    })
  }

  private async poll(p: Pending) {
    if (this.pending !== p) return
    const base = p.base // o endereco do login em andamento, nao o da configuracao
    if ((await this.io.now()) >= p.expiresAt) return this.cancelLogin('Adaflow: o codigo de login expirou. Rode /adaflow login de novo.')
    let res: HttpResponse
    try {
      res = await this.io.fetch(`${base}/v1/auth/device/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ grant_type: DEVICE_GRANT, device_code: p.deviceCode, client_id: CLIENT_ID }),
      })
    } catch {
      return this.schedulePoll() // rede instavel: tenta de novo no proximo intervalo
    }
    if (this.pending !== p) return
    if (res.ok) {
      const token = str(parseJson(res.text).access_token)
      if (!token) return this.cancelLogin('Adaflow: resposta de login sem token. Tente /adaflow login de novo.')
      p.timer?.cancel()
      this.pending = null
      await this.io.setLogin(null).catch(() => undefined)
      return this.completeLogin(token, base)
    }
    switch (deviceError(res)) {
      case 'authorization_pending':
        return this.schedulePoll()
      case 'slow_down':
        p.intervalMs += SLOW_DOWN_MS
        return this.schedulePoll()
      case 'expired_token':
        return this.cancelLogin('Adaflow: o codigo de login expirou. Rode /adaflow login de novo.')
      case 'access_denied':
        return this.cancelLogin('Adaflow: login negado no navegador.')
      default:
        if (res.status >= 500 || res.status === 429) return this.schedulePoll()
        return this.cancelLogin(`Adaflow: login recusado pela plataforma (HTTP ${res.status}).`)
    }
  }

  private async completeLogin(token: string, base: string) {
    const now = await this.io.now()
    const session: StoredSession = {
      token,
      baseUrl: base,
      createdAt: now,
      loggedInAt: now,
      organizationId: null,
      organizationName: null,
      userEmail: null,
    }
    // get-session e uma das tres rotas que a sessao de CLI alcanca (§4.1e): createdAt e org ativa.
    try {
      const res = await this.io.fetch(`${base}/v1/auth/get-session`, { headers: bearer(token) })
      if (res.ok) {
        const body = parseJson(res.text)
        const s = (body.session ?? {}) as Record<string, unknown>
        const u = (body.user ?? {}) as Record<string, unknown>
        const created = Date.parse(String(s.createdAt ?? ''))
        if (Number.isFinite(created) && created <= now) session.createdAt = created
        session.organizationId = str(s.activeOrganizationId)
        session.userEmail = str(u.email)
      }
    } catch {
      // segue sem: o teto passa a contar da hora do login
    }
    this.session = session
    this.jwt = null
    await this.io.set(STORE_SESSION, session)
    const jwt = await this.getJwt(true).catch(() => null)
    if (jwt) {
      const claims = decodeJwtPayload(jwt)
      const org = (claims.organization ?? {}) as Record<string, unknown>
      session.organizationId ??= str(claims.organizationId) ?? str(claims.activeOrganizationId) ?? str(org.id)
      session.organizationName = str(claims.organizationName) ?? str(org.name)
      session.userEmail ??= str(claims.email)
      await this.io.set(STORE_SESSION, session)
    }
    if (!this.session) return // o JWT ja foi recusado: getJwt avisou
    this.io.toast(`Adaflow: conectado${session.organizationName || session.organizationId ? ` (${session.organizationName ?? session.organizationId})` : ''}.`)
    await this.record('session.start', { reason: 'login' })
  }

  async logout(): Promise<string> {
    this.cancelLogin()
    const s = this.session
    let remote = 'sem sessao no servidor'
    if (s) {
      try {
        const res = await this.io.fetch(`${s.baseUrl}/v1/auth/sign-out`, {
          method: 'POST',
          headers: { ...bearer(s.token), 'content-type': 'application/json' },
          body: '{}',
        })
        remote = res.ok ? 'sessao encerrada no servidor' : `o servidor respondeu HTTP ${res.status}; revogue pela lista de sessoes se preciso`
      } catch {
        remote = 'servidor inacessivel; revogue pela lista de sessoes da plataforma'
      }
    }
    this.session = null
    this.jwt = null
    this.queue = []
    this.backoffMs = 0
    this.nextAttemptAt = 0
    await this.io.del(STORE_SESSION).catch(() => undefined)
    await this.io.del(STORE_QUEUE).catch(() => undefined)
    return s ? `Desconectado do Adaflow (${remote}). Token local e fila pendente apagados.` : 'Nenhuma sessao do Adaflow neste computador.'
  }

  async status(): Promise<string> {
    const now = await this.io.now()
    const lines = ['**Adaflow: status**', '']
    if (!this.cfg.enabled) lines.push('- Envio de auditoria: **desligado** (`enabled` = false)')
    if (this.pending) lines.push(`- Login pendente: codigo **${this.pending.userCode}**`)
    const s = this.session
    if (!s) {
      lines.push('- Sessao: nao conectado. Rode `/adaflow login`.')
    } else {
      lines.push(`- Organizacao: ${s.organizationName ?? s.organizationId ?? 'desconhecida'}${s.userEmail ? ` (${s.userEmail})` : ''}`)
      lines.push(`- Validade restante: ${fmtDuration(s.createdAt + SESSION_CAP_MS - now)} (teto de 7 dias desde o login)`)
      lines.push(`- Plataforma: ${s.baseUrl}`)
    }
    lines.push(`- Ultimo envio: ${fmtAgo(now, this.lastSentAt)}`)
    lines.push(`- Fila pendente: ${this.queue.length} evento(s)`)
    if (this.lastError) lines.push(`- Ultimo erro: ${this.lastError}`)
    return lines.join('\n')
  }

  // ---------- JWT de 15 min ----------

  private async getJwt(force: boolean): Promise<string | null> {
    const s = this.session
    if (!s) return null
    const now = await this.io.now()
    if (now >= s.createdAt + SESSION_CAP_MS) {
      await this.expire('a sessao passou do teto de 7 dias')
      return null
    }
    if (!force && this.jwt && this.jwt.exp - JWT_SKEW_MS > now) return this.jwt.token
    const res = await this.io.fetch(`${s.baseUrl}/v1/auth/token`, { headers: bearer(s.token) })
    if (res.status === 401) {
      await this.expire('a sessao expirou ou foi revogada')
      return null
    }
    if (!res.ok) throw new Error(`token HTTP ${res.status}`)
    const token = str(parseJson(res.text).token)
    if (!token) throw new Error('token ausente')
    const exp = num(decodeJwtPayload(token).exp)
    this.jwt = { token, exp: exp !== null ? exp * 1000 : now + JWT_FALLBACK_MS }
    return token
  }

  private async expire(why: string) {
    this.session = null
    this.jwt = null
    await this.io.del(STORE_SESSION).catch(() => undefined)
    this.io.toast(`Adaflow: ${why}. Rode /adaflow login para voltar a registrar a auditoria.`)
  }

  // ---------- eventos ----------

  // Sem login (ou desligado) e no-op silencioso. Nao faz rede: so enfileira.
  async record(kind: EventKind, metadata: Record<string, unknown>) {
    if (!this.cfg.enabled || !this.session) return
    const now = await this.io.now()
    const event: IngestEvent = {
      app: APP,
      eventId: crypto.randomUUID(),
      ...EVENTS[kind],
      success: kind !== 'tool.denied',
      metadata: safeMetadata({ sessionId: this.sessionId ?? undefined, ...metadata }),
      occurredAt: new Date(now).toISOString(),
    }
    if (kind === 'turn.complete' && metadata.reason !== 'answer') event.success = false
    this.queue.push(event)
    if (this.queue.length > QUEUE_MAX) this.queue.splice(0, this.queue.length - QUEUE_MAX)
    await this.io.set(STORE_QUEUE, this.queue).catch(() => undefined)
    if (this.queue.length >= BATCH_MAX) void this.flush()
  }

  flush(): Promise<void> {
    this.flushing ??= this.doFlush()
      .catch(err => this.io.log(`adaflow-governance: flush falhou: ${String(err)}`))
      .finally(() => {
        this.flushing = null
      })
    return this.flushing
  }

  private async doFlush() {
    if (!this.cfg.enabled || !this.session || this.queue.length === 0) return
    const now = await this.io.now()
    if (now < this.nextAttemptAt) return
    const minTime = now - OCCURRED_MAX_AGE_MS
    this.queue = this.queue.filter(ev => !ev.occurredAt || Date.parse(ev.occurredAt) >= minTime)
    // So o que ja estava na fila: o que chega durante o envio espera o proximo, em lote.
    let budget = this.queue.length
    while (this.session && budget > 0 && this.queue.length > 0) {
      const batch = this.queue.slice(0, Math.min(BATCH_MAX, budget))
      budget -= batch.length
      let res: HttpResponse
      try {
        let jwt = await this.getJwt(false)
        if (!jwt) return
        res = await this.post(jwt, batch)
        if (res.status === 401) {
          jwt = await this.getJwt(true)
          if (!jwt) return
          res = await this.post(jwt, batch)
        }
      } catch (err) {
        return this.backoff(now, `${HTTP_TIMEOUT_NOTE}: ${String(err)}`)
      }
      if (res.status === 408 || res.status === 425 || res.status === 429 || res.status >= 500) {
        return this.backoff(now, `HTTP ${res.status}`)
      }
      const sent = new Set(batch.map(ev => ev.eventId))
      this.queue = this.queue.filter(ev => !sent.has(ev.eventId))
      if (res.ok) {
        const body = parseJson(res.text)
        const rejected = Array.isArray(body.rejected) ? body.rejected.length : 0
        this.lastError = rejected > 0 ? `${rejected} evento(s) rejeitado(s) pela validacao` : null
        this.lastSentAt = await this.io.now()
        await this.io.set(STORE_LAST_SENT, this.lastSentAt).catch(() => undefined)
      } else {
        // 400/403/404/413: reenviar nao muda o resultado; o lote e descartado.
        this.lastError = `lote descartado: HTTP ${res.status}`
        this.io.log(`adaflow-governance: ${this.lastError} ${res.text.slice(0, 200)}`)
      }
      this.backoffMs = 0
      this.nextAttemptAt = 0
      await this.io.set(STORE_QUEUE, this.queue).catch(() => undefined)
    }
  }

  private post(jwt: string, events: IngestEvent[]) {
    return this.io.fetch(`${this.session!.baseUrl}/v1/audit/events/batch`, {
      method: 'POST',
      headers: { ...bearer(jwt), 'content-type': 'application/json' },
      body: JSON.stringify({ events }),
    })
  }

  private backoff(now: number, why: string) {
    this.backoffMs = Math.min(BACKOFF_MAX_MS, Math.max(BACKOFF_MIN_MS, this.backoffMs * 2))
    this.nextAttemptAt = now + this.backoffMs
    this.lastError = why
  }
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}`, accept: 'application/json' })

const publicLogin = (p: Pending): GovernanceLogin => ({
  userCode: p.userCode,
  verificationUri: p.verificationUri,
  verificationUriComplete: p.verificationUriComplete,
  expiresAt: p.expiresAt,
})
