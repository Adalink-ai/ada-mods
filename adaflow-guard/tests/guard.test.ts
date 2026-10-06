import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// O que fica abaixo do plugin: o disco (files) e a propria ferramenta, que so roda se o guard deixar.
const world = (on: On, files: Record<string, string> = {}) => {
  const ran: string[] = []
  const toasts: string[] = []
  on('fs.read', (_$, e) => {
    const text = files[e.path]
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('ui.log', () => ({ value: undefined }) as never)
  on('ui.toast', (_$, e) => {
    toasts.push(String((e as { text?: string }).text ?? ''))
    return { value: undefined } as never
  })
  on('tool.call', (_$, e) => {
    ran.push(e.tool)
    return { result: {} as never, text: 'ok' }
  })
  return { ran, toasts }
}

const write = ($: any, file_path: string, content: string) => $.tool.call({ tool: 'Write', file_path, content })
const edit = ($: any, file_path: string, old_string: string, new_string: string, replace_all?: boolean) =>
  $.tool.call({ tool: 'Edit', file_path, old_string, new_string, replace_all })
const bash = ($: any, command: string) => $.tool.call({ tool: 'Bash', command })

const CLIENT = `'use client'\nimport { useState } from 'react'\n`

test('bloqueia app token em client component', async ($, on) => {
  const w = world(on)
  const r = await write($, '/app/src/components/chat.tsx', `${CLIENT}const t = process.env.ADAFLOW_APP_TOKEN\n`)
  expect(r.deny).toBeDefined()
  expect(r.deny).toContain('token-in-client')
  expect(w.ran).toEqual([])
})

test('bloqueia x-ada-token e appToken em client component', async ($, on) => {
  world(on)
  expect((await write($, '/a/x.tsx', `${CLIENT}fetch(u, { headers: { 'x-ada-token': t } })`)).deny).toBeDefined()
  expect((await write($, '/a/y.tsx', `${CLIENT}const c = new Adaflow({ appToken })`)).deny).toBeDefined()
})

test('o mesmo codigo em arquivo de servidor passa', async ($, on) => {
  const w = world(on)
  const r = await write($, '/app/src/app/api/adaflow/route.ts', `const t = process.env.ADAFLOW_APP_TOKEN\nfetch(u, { headers: { 'x-ada-token': t } })`)
  expect(r.deny).toBeUndefined()
  expect(w.ran).toEqual(['Write'])
})

test('diretiva use client precedida de comentario continua valendo', async ($, on) => {
  world(on)
  const r = await write($, '/a/z.tsx', `// chat\n/* ui */\n"use client"\nconst t = process.env.ADA_TOKEN`)
  expect(r.deny).toBeDefined()
})

test('bloqueia prefixo publico no nome do token, em qualquer arquivo', async ($, on) => {
  world(on)
  for (const [p, c] of [
    ['/a/.env', 'NEXT_PUBLIC_ADAFLOW_APP_TOKEN=abc'],
    ['/a/vite.config.ts', 'import.meta.env.VITE_ADA_TOKEN'],
    ['/a/next.config.ts', 'env: { NEXT_PUBLIC_ADALINK_APP_TOKEN: x }'],
  ] as const) {
    const r = await write($, p, c)
    expect(r.deny).toBeDefined()
    expect(r.deny).toContain('public-token-env')
  }
})

test('NEXT_PUBLIC_ADAFLOW_URL e NEXT_PUBLIC_ADAFLOW_SOURCE (SSO) nao sao tokens', async ($, on) => {
  world(on)
  const r = await write($, '/a/.env.example', 'NEXT_PUBLIC_ADAFLOW_URL="https://app.adalink.ai"\nNEXT_PUBLIC_ADAFLOW_SOURCE="meu-app"')
  expect(r.deny).toBeUndefined()
})

test('bloqueia chamada direta ao gateway em client component', async ($, on) => {
  world(on)
  const r = await write($, '/a/c.tsx', `${CLIENT}fetch('https://adalink-api-gateway.onrender.com/v1/chat')`)
  expect(r.deny).toBeDefined()
  expect(r.deny).toContain('browser-gateway')
})

test('bloqueia token literal, mas aceita placeholder e .env real', async ($, on) => {
  world(on)
  const real = 'ada_live_9f8e7d6c5b4a39281716'
  expect((await write($, '/a/lib/client.ts', `headers: { 'x-ada-token': '${real}' }`)).deny).toBeDefined()
  expect((await write($, '/a/lib/c2.ts', `const c = { appToken: "${real}" }`)).deny).toBeDefined()
  expect((await write($, '/a/.env.example', `ADAFLOW_APP_TOKEN=${real}`)).deny).toBeDefined()
  expect((await write($, '/a/.env.example', `ADAFLOW_APP_TOKEN=your-app-token-goes-here-123`)).deny).toBeUndefined()
  expect((await write($, '/a/.env', `ADAFLOW_APP_TOKEN=${real}`)).deny).toBeUndefined()
  expect((await write($, '/a/.env.local', `ADAFLOW_APP_TOKEN=${real}`)).deny).toBeUndefined()
  expect((await write($, '/a/lib/ok.ts', `headers: { 'x-ada-token': process.env.ADAFLOW_APP_TOKEN }`)).deny).toBeUndefined()
})

test('Edit: bloqueia so o que a edicao introduz', async ($, on) => {
  world(on, { '/a/c.tsx': `${CLIENT}export const x = 1\n` })
  const r = await edit($, '/a/c.tsx', 'export const x = 1', 'export const x = process.env.ADAFLOW_APP_TOKEN')
  expect(r.deny).toBeDefined()
  expect(r.deny).toContain('token-in-client')
})

test('Edit: arquivo que ja tinha o problema nao trava uma edicao que nao o agrava', async ($, on) => {
  const w = world(on, { '/a/c.tsx': `${CLIENT}const t = process.env.ADAFLOW_APP_TOKEN\nconst y = 1\n` })
  const r = await edit($, '/a/c.tsx', 'const y = 1', 'const y = 2')
  expect(r.deny).toBeUndefined()
  expect(w.ran).toEqual(['Edit'])
})

test('Edit: remover a violacao e permitido e replace_all e considerado', async ($, on) => {
  const w = world(on, { '/a/c.tsx': `${CLIENT}const t = 1\nconst u = 1\n` })
  expect((await edit($, '/a/c.tsx', 'const t = process.env.ADAFLOW_APP_TOKEN', 'const t = 1')).deny).toBeUndefined()
  expect((await edit($, '/a/c.tsx', '= 1', '= process.env.ADA_TOKEN', true)).deny).toBeDefined()
  expect(w.ran).toEqual(['Edit'])
})

test('Write sobre arquivo novo (inexistente) funciona', async ($, on) => {
  const w = world(on)
  const r = await write($, '/a/novo.ts', 'export const a = 1')
  expect(r.deny).toBeUndefined()
  expect(w.ran).toEqual(['Write'])
})

test('Bash: bloqueia o que imprime o token, deixa o resto', async ($, on) => {
  const w = world(on)
  for (const c of [
    'echo $ADAFLOW_APP_TOKEN',
    'echo "token=${ADALINK_APP_TOKEN}"',
    'printenv ADAFLOW_APP_TOKEN',
    'env | grep -i token',
    'cat <<< "$ADAFLOW_JWT"',
  ]) {
    const r = await bash($, c)
    expect(r.deny).toBeDefined()
    expect(r.deny).toContain('token-print')
  }
  for (const c of ['[ -n "$ADAFLOW_APP_TOKEN" ] && echo definido', 'pnpm test', 'curl -s -H "x-ada-token: $ADAFLOW_APP_TOKEN" $URL | jq .data']) {
    expect((await bash($, c)).deny).toBeUndefined()
  }
  expect(w.ran.length).toBe(3)
})

test('modo warn deixa passar e avisa', { options: { mode: 'warn' } }, async ($, on) => {
  const w = world(on)
  const r = await write($, '/a/c.tsx', `${CLIENT}const t = process.env.ADAFLOW_APP_TOKEN`)
  expect(r.deny).toBeUndefined()
  expect(w.ran).toEqual(['Write'])
  expect(w.toasts.join(' ')).toContain('token-in-client')
})
