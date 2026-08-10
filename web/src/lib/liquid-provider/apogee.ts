import { NETWORK_CONFIG } from '@/constants/network-config'

import { discoverApogeeProvider } from './discovery'
import {
  isLiquidConnection,
  type LiquidConnection,
  type LiquidProvider,
  type TxManifestExecutionResult,
  type TxManifestInvocation,
} from './types'

export const LIQUID_TESTNET_CHAIN_ID = 'bip122:a771da8e52ee6ad581ed1e9a99825e5b'
export const SIMPLICITY_LENDING_V3_BUNDLE_HASH =
  'sha256:a85cd2b87a5c763a5e8db463a4784a0861b8994b3e3ae276fde36a3d72b1bcde' as const
export const ACCEPT_OFFER_ACTION = 'lending_contract.AcceptOffer'

const CONNECT_METHODS = ['experimental_executeTxManifest', 'getBalance'] as const
const CONNECT_EVENTS = ['wallet_connectionChanged'] as const

function hasRequestedPermissions(connection: LiquidConnection): boolean {
  return (
    CONNECT_METHODS.every(method => connection.permissions.methods.includes(method)) &&
    CONNECT_EVENTS.every(event => connection.permissions.events.includes(event))
  )
}

interface ManifestSupport {
  supported: boolean
  bundleHash: string
  status: 'builtin' | 'unknown' | 'blocked'
  supportedActions?: string[]
}

function isManifestSupport(value: unknown): value is ManifestSupport {
  if (!value || typeof value !== 'object') return false
  const support = value as Partial<ManifestSupport>
  return (
    typeof support.supported === 'boolean' &&
    support.bundleHash === SIMPLICITY_LENDING_V3_BUNDLE_HASH &&
    (support.status === 'builtin' || support.status === 'unknown' || support.status === 'blocked')
  )
}

async function requireManifestSupport(provider: LiquidProvider): Promise<void> {
  const support = await provider.request({
    method: 'experimental_getTxManifestSupport',
    params: { bundleHash: SIMPLICITY_LENDING_V3_BUNDLE_HASH },
  })
  if (
    !isManifestSupport(support) ||
    !support.supported ||
    !support.supportedActions?.includes(ACCEPT_OFFER_ACTION)
  ) {
    throw new Error('This version of Apogee does not support Simplicity Lending offer acceptance.')
  }
}

export async function connectApogee(): Promise<{
  provider: LiquidProvider
  connection: LiquidConnection
}> {
  const { provider } = await discoverApogeeProvider()
  await requireManifestSupport(provider)
  const result = await provider.request({
    method: 'wallet_connect',
    params: {
      chains: [LIQUID_TESTNET_CHAIN_ID],
      methods: [...CONNECT_METHODS],
      events: [...CONNECT_EVENTS],
    },
  })
  if (
    !isLiquidConnection(result) ||
    result.chainId !== LIQUID_TESTNET_CHAIN_ID ||
    !hasRequestedPermissions(result)
  ) {
    throw new Error('Apogee connected an unexpected Liquid account or network.')
  }
  return { provider, connection: result }
}

export async function resumeApogee(): Promise<{
  provider: LiquidProvider
  connection: LiquidConnection
} | null> {
  const { provider } = await discoverApogeeProvider()
  await requireManifestSupport(provider)
  const result = await provider.request({ method: 'wallet_getConnection' })
  if (result === null) return null
  if (!isLiquidConnection(result) || result.chainId !== LIQUID_TESTNET_CHAIN_ID) return null
  if (!hasRequestedPermissions(result)) return null
  return { provider, connection: result }
}

export async function disconnectApogee(provider: LiquidProvider): Promise<void> {
  await provider.request({ method: 'wallet_disconnect' })
}

export async function getApogeeBalances(
  provider: LiquidProvider,
  connection: LiquidConnection,
): Promise<Record<string, string>> {
  const assets = [
    NETWORK_CONFIG.collateralAsset.id,
    NETWORK_CONFIG.principalAsset.id,
    connection.policyAssetId.slice(connection.policyAssetId.lastIndexOf(':') + 1),
  ]
  const uniqueAssets = [...new Set(assets)]
  const entries = await Promise.all(
    uniqueAssets.map(async asset => {
      const result = (await provider.request({
        method: 'getBalance',
        params: { assetId: `${connection.chainId}/elip144:${asset}` },
      })) as { balance?: unknown }
      if (!result || typeof result.balance !== 'string' || !/^\d+$/.test(result.balance)) {
        throw new Error(`Apogee returned an invalid balance for asset ${asset}.`)
      }
      return [asset, result.balance] as const
    }),
  )
  return Object.fromEntries(entries)
}

export async function executeApogeeTxManifest(
  provider: LiquidProvider,
  invocation: TxManifestInvocation,
): Promise<TxManifestExecutionResult> {
  const result = (await provider.request({
    method: 'experimental_executeTxManifest',
    params: invocation as unknown as Record<string, unknown>,
  })) as Partial<TxManifestExecutionResult>
  if (
    result.status !== 'broadcast' ||
    result.requestId !== invocation.requestId ||
    result.chainId !== invocation.chainId ||
    result.accountIdentifier !== invocation.accountIdentifier ||
    result.bundleHash !== invocation.manifest.bundleHash ||
    result.action !== invocation.action ||
    typeof result.txid !== 'string' ||
    !/^[0-9a-f]{64}$/.test(result.txid)
  ) {
    throw new Error('Apogee returned an invalid TX Manifest execution result.')
  }
  return result as TxManifestExecutionResult
}
