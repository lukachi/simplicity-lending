import { env } from '@/constants/env'
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
export const LIQUID_REGTEST_CHAIN_ID = 'bip122:00902a6b70c2ca83b5d9c815d96a0e2f'
export const SIMPLICITY_LENDING_V3_BUNDLE_HASH =
  'sha256:debdae89777fdd21fec2d763efe028876f267ff214aca9ddf9b3735d7657be15' as const
export const CREATE_FACTORY_ACTION = 'issuance_factory.CreateFactory'
export const CREATE_OFFER_ACTION = 'lending_contract.CreateOffer'
export const ACCEPT_OFFER_ACTION = 'lending_contract.AcceptOffer'
export const CLAIM_PRINCIPAL_ACTION = 'lending_contract.ClaimPrincipal'
export const REPAY_LOAN_ACTION = 'lending_contract.RepayLoan'
export const CANCEL_OFFER_ACTION = 'lending_contract.CancelOffer'
export const LIQUIDATE_OFFER_ACTION = 'lending_contract.LiquidateOffer'
export const CLAIM_LENDER_VAULT_ACTION = 'lending_contract.ClaimLenderVault'

const REQUIRED_ACTIONS = [
  CREATE_FACTORY_ACTION,
  CREATE_OFFER_ACTION,
  ACCEPT_OFFER_ACTION,
  CLAIM_PRINCIPAL_ACTION,
  REPAY_LOAN_ACTION,
  CANCEL_OFFER_ACTION,
  LIQUIDATE_OFFER_ACTION,
  CLAIM_LENDER_VAULT_ACTION,
] as const

const CONNECT_METHODS = ['experimental_executeTxManifest', 'getBalance'] as const

function apogeeChainId(): string {
  if (env.VITE_NETWORK === 'liquidtestnet') return LIQUID_TESTNET_CHAIN_ID
  if (env.VITE_NETWORK === 'regtest') return LIQUID_REGTEST_CHAIN_ID
  throw new Error('Apogee TX Manifest lending is available only on testnet and local regtest.')
}

function hasRequestedPermissions(connection: LiquidConnection): boolean {
  return CONNECT_METHODS.every(method => connection.permissions.methods.includes(method))
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
    !REQUIRED_ACTIONS.every(action => support.supportedActions?.includes(action))
  ) {
    throw new Error(
      'This version of Apogee does not support the required Simplicity Lending actions.',
    )
  }
}

export async function connectApogee(): Promise<{
  provider: LiquidProvider
  connection: LiquidConnection
}> {
  const { provider } = await discoverApogeeProvider()
  await requireManifestSupport(provider)
  const chainId = apogeeChainId()
  const result = await provider.request({
    method: 'wallet_connect',
    params: {
      chains: [chainId],
      methods: [...CONNECT_METHODS],
      // wallet_connectionChanged is part of the provider's always-available
      // event surface. Apogee rejects attempts to request it as a permission.
      events: [],
    },
  })
  if (
    !isLiquidConnection(result) ||
    result.chainId !== chainId ||
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
  const chainId = apogeeChainId()
  const result = await provider.request({ method: 'wallet_getConnection' })
  if (result === null) return null
  if (!isLiquidConnection(result) || result.chainId !== chainId) return null
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
