import type { Register } from 'claude-code'

// O segredo e o app token do Adaflow (header x-ada-token). O JWT do usuario e curto e vive no
// browser por desenho; o app token e de longa duracao e so pode existir no servidor.
const TOKEN_ENV = /\b(?:ADAFLOW_APP_TOKEN|ADALINK_APP_TOKEN|ADA_TOKEN)\b/
const TOKEN_NAME = new RegExp(`${TOKEN_ENV.source}|x-ada-token|\\bappToken\\b`, 'i')

// Variavel que o bundler entrega ao browser (NEXT_PUBLIC_, VITE_, REACT_APP_, PUBLIC_) com o token no nome.
const PUBLIC_TOKEN = /(?<![A-Z0-9_])(?:NEXT_PUBLIC|VITE|REACT_APP|PUBLIC)_[A-Z0-9_]*(?:APP_?TOKEN|ADA_?TOKEN)/

// Primeira instrucao do arquivo e a diretiva 'use client' (comentarios iniciais sao ignorados).
const IS_CLIENT = /^\s*(?:\/\/[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*['"]use client['"]/

// O browser fala com o app (proxy /api/adaflow/*), nunca direto com o gateway.
const BROWSER_GATEWAY = /adalink-api-gateway\.onrender\.com|NEXT_PUBLIC_ADAFLOW_(?:BASE_URL|API_URL|GATEWAY)/

const LITERALS = [
  /x-ada-token['"`]?\s*[:=,]\s*['"`]([^'"`\s$]{16,})['"`]/gi,
  /\bappToken\s*[:=]\s*['"`]([^'"`\s$]{16,})['"`]/g,
  /\b(?:ADAFLOW_APP_TOKEN|ADALINK_APP_TOKEN|ADA_TOKEN)\s*[:=]\s*['"`]?([A-Za-z0-9._~+/=-]{20,})['"`]?/g,
]
const PLACEHOLDER = /your|seu[-_ ]|exemplo|example|placeholder|changeme|replace|todo|xxx|\*\*\*|<|>/i

const hasLiteralToken = (text: string) =>
  LITERALS.some(re => [...text.matchAll(re)].some(m => !PLACEHOLDER.test(m[1] ?? '')))

const RULES: Record<string, string> = {
  'public-token-env':
    'o app token nao pode ter prefixo NEXT_PUBLIC_/VITE_/REACT_APP_/PUBLIC_: o bundler o entregaria ao browser. Guarde-o em variavel so de servidor (ADAFLOW_APP_TOKEN) e use-o em route handler.',
  'token-in-client':
    'este arquivo e client component ("use client") e referencia o app token / x-ada-token. O app token e segredo de servidor: no browser use o JWT do usuario (SSO) e passe pelo proxy /api/adaflow/[...path], que anexa a credencial no servidor.',
  'browser-gateway':
    'este arquivo e client component ("use client") e chama o gateway da plataforma direto. O browser nunca fala com o gateway: chame o proxy do app (/api/adaflow/[...path]) com allowlist.',
  'literal-token':
    'ha um token literal no codigo-fonte. Leia de process.env.ADAFLOW_APP_TOKEN (server-side) e mantenha o valor em .env/.env.local fora do git.',
}

const violations = (path: string, text: string): Set<string> => {
  const found = new Set<string>()
  const base = path.split('/').pop() ?? ''
  const isRealEnv = base === '.env' || base === '.env.local'
  if (PUBLIC_TOKEN.test(text)) found.add('public-token-env')
  if (!isRealEnv && hasLiteralToken(text)) found.add('literal-token')
  if (IS_CLIENT.test(text)) {
    if (TOKEN_NAME.test(text)) found.add('token-in-client')
    if (BROWSER_GATEWAY.test(text)) found.add('browser-gateway')
  }
  return found
}

// So o que a edicao introduz: um arquivo que ja tinha o problema nao trava o resto do trabalho nele.
const introduced = (before: Set<string>, after: Set<string>) => [...after].filter(id => !before.has(id))

const applyEdit = (text: string, oldString: string, newString: string, replaceAll?: boolean) => {
  if (oldString === '') return text
  if (replaceAll) return text.split(oldString).join(newString)
  const i = text.indexOf(oldString)
  return i < 0 ? text : text.slice(0, i) + newString + text.slice(i + oldString.length)
}

// O que imprime o segredo no transcript. Para checar se a variavel existe: [ -n "$ADAFLOW_APP_TOKEN" ] && echo set
const PRINTS_TOKEN = [
  /\b(?:echo|printf|cat)\b[^\n|;&]*\$\{?(?:ADAFLOW_APP_TOKEN|ADALINK_APP_TOKEN|ADA_TOKEN|ADAFLOW_JWT)\b/,
  /\bprintenv\s+(?:ADAFLOW|ADALINK|ADA_)\w*/,
  /\b(?:env|printenv|export\s+-p|set)\b[^\n]*\|\s*(?:grep|rg)\b[^\n]*(?:ada|token)/i,
]

const MAX_CHARS = 500_000

// Motivo da recusa (ou undefined): puro, sem `$`; o efeito fica no ponto de chamada.
const explain = (ids: string[], where: string) =>
  ids.length === 0 ? undefined : `adaflow-guard (${ids.join(', ')}) em ${where}: ${ids.map(id => RULES[id]).join(' ')}`

const TOKEN_PRINT_REASON =
  'adaflow-guard (token-print): este comando imprimiria o app token no transcript. Para checar se a variavel existe use: [ -n "$ADAFLOW_APP_TOKEN" ] && echo definido'

export const register: Register = (on, options) => {
  const isDeny = String(options.mode) !== 'warn'

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    if (e.content.length > MAX_CHARS) return next(e)
    const before = await $.fs.read(e.file_path).catch(() => '')
    const reason = explain(introduced(violations(e.file_path, before), violations(e.file_path, e.content)), e.file_path)
    if (reason) {
      $.ui.log(reason, { to: 'debug' })
      if (isDeny) return { deny: reason }
      $.ui.toast(reason.slice(0, 120))
    }
    return next(e)
  }).catch(($, e, next) => {
    // Um erro do proprio guard nunca trava o trabalho: segue sem a verificacao e avisa.
    $.ui.toast('adaflow-guard: erro interno, verificacao ignorada')
    return next(e)
  })

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    if (e.new_string.length > MAX_CHARS) return next(e)
    const before = await $.fs.read(e.file_path).catch(() => '')
    const after = applyEdit(before, e.old_string, e.new_string, e.replace_all)
    const reason = explain(introduced(violations(e.file_path, before), violations(e.file_path, after)), e.file_path)
    if (reason) {
      $.ui.log(reason, { to: 'debug' })
      if (isDeny) return { deny: reason }
      $.ui.toast(reason.slice(0, 120))
    }
    return next(e)
  }).catch(($, e, next) => {
    $.ui.toast('adaflow-guard: erro interno, verificacao ignorada')
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, ($, e, next) => {
    if (PRINTS_TOKEN.some(re => re.test(e.command))) {
      $.ui.log(TOKEN_PRINT_REASON, { to: 'debug' })
      if (isDeny) return { deny: TOKEN_PRINT_REASON }
      $.ui.toast('adaflow-guard: comando imprime o app token')
    }
    return next(e)
  }).catch(($, e, next) => {
    $.ui.toast('adaflow-guard: erro interno, verificacao ignorada')
    return next(e)
  })
}
