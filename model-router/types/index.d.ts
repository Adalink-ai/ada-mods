export type Tier = 'haiku' | 'sonnet' | 'opus'
export type Route = { tier: Tier; model: string; reason: string }

// Dentro de `declare module 'claude-code'` o nome `Tier` resolve para um tipo do proprio
// claude-code; este alias, fora do bloco, e o nosso.
export type RouterTier = Tier

declare module 'claude-code' {
  interface PluginState {
    'model-router': { route: Route | null; forced: RouterTier | null }
  }
}
