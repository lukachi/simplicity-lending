export interface LiquidProviderInfo {
  readonly uuid: string
  readonly name: string
  readonly icon: string
  readonly rdns: string
}

export interface LiquidProviderError extends Error {
  readonly code: number
  readonly data?: { reason?: string; cause?: string; [key: string]: unknown }
}

export interface LiquidConnection {
  readonly accountIdentifier: string
  readonly chainId: string
  readonly policyAssetId: string
  readonly permissions: {
    readonly methods: readonly string[]
    readonly events: readonly string[]
  }
}

export interface LiquidProvider {
  request(args: { method: string; params?: Record<string, unknown> }): Promise<unknown>
  on(args: { event: string; listener: (payload: unknown) => void }): () => void
}

export interface LiquidProviderDetail {
  readonly info: LiquidProviderInfo
  readonly provider: LiquidProvider
}

export interface TxManifestInvocation {
  protocolVersion: '0.1'
  requestId: string
  chainId: string
  accountIdentifier: string
  manifest: { bundleHash: `sha256:${string}` }
  action: string
  arguments: Record<string, string>
  providedInputs: Record<string, { txid: string; vout: number }>
  constraints?: { maxFee?: string; validUntilHeight?: number }
}

export interface TxManifestExecutionResult {
  requestId: string
  chainId: string
  accountIdentifier: string
  bundleHash: `sha256:${string}`
  action: string
  status: 'broadcast'
  txid: string
}

export function isLiquidConnection(value: unknown): value is LiquidConnection {
  if (!value || typeof value !== 'object') return false
  const connection = value as Partial<LiquidConnection>
  return (
    typeof connection.accountIdentifier === 'string' &&
    typeof connection.chainId === 'string' &&
    typeof connection.policyAssetId === 'string' &&
    !!connection.permissions &&
    Array.isArray(connection.permissions.methods) &&
    Array.isArray(connection.permissions.events)
  )
}

export function liquidProviderErrorCode(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null
  const code = (error as { code?: unknown }).code
  return typeof code === 'number' ? code : null
}
