// Login pendente do device flow, desenhado na faixa acima do prompt. So o que o usuario ve:
// o device_code (que vira credencial) fica na memoria do modulo, nunca em $.state, que
// qualquer plugin le.
export type GovernanceLogin = {
  userCode: string
  verificationUri: string
  verificationUriComplete: string | null
  expiresAt: number
}

// Dentro de `declare module 'claude-code'` use o alias, para nao colidir com nomes do claude-code.
export type GovernancePendingLogin = GovernanceLogin

declare module 'claude-code' {
  interface PluginState {
    'adaflow-governance': { login: GovernancePendingLogin | null }
  }
}
