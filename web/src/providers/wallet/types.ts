import type {
  EsploraClient,
  Pset,
  Transaction,
  WalletTxOut,
  Wollet,
  WolletDescriptor,
} from '@lilbonekit/lwk-web'

import type { TxManifestExecutionResult, TxManifestInvocation } from '@/lib/liquid-provider/types'
import type { WalletConnector } from '@/lib/wallet-core/connector/types'
import type { WalletCache } from '@/lib/wallet-core/store/walletCache'
import type { ConnectionStatus, WalletType } from '@/lib/wallet-core/types'

export interface ConnectOptions {
  seedMnemonic?: string
  /** Connect to the event-discovered Apogee browser wallet. */
  apogee?: boolean
  /** Connect via the experimental SideSwap wallet connect flow instead of Jade/seed. */
  sideswap?: boolean
  /** Only reattach to a still-live SideSwap session; never start a fresh login request. */
  resumeOnly?: boolean
}

export type CachePolicy = 'preserve' | 'clear'

export interface WalletContextValue extends WalletState {
  isReady: boolean
  connect(variant: WalletType, options?: ConnectOptions): Promise<void>
  /** Cancels an in-flight SideSwap login/sign request and resets the connection. */
  cancelPendingRequest(): Promise<void>
  disconnect(options?: { cachePolicy?: CachePolicy }): Promise<void>
  syncWallet(): Promise<void>
  /** Applies a just-broadcast tx to local wallet state instantly, without a network scan. */
  applyBroadcastTransaction(tx: Transaction): void
  signPset(pset: Pset): Promise<Pset>
  getBlindedWalletUtxos(): Promise<WalletTxOut[]>
  getWollet(): Promise<Wollet>
  getReceiveAddress(): Promise<string | null>
  verifyReceiveAddress(): Promise<string>
  executeTxManifest(invocation: TxManifestInvocation): Promise<TxManifestExecutionResult>
  addPortfolioScript(scriptPubkey: string): Promise<void>
}

export interface WalletSession {
  connector: WalletConnector
  descriptor: WolletDescriptor
  wollet: Wollet
  esploraClient: EsploraClient
  cache: WalletCache
}

export interface SavedLocalSession {
  backend?: 'local'
  connectorId: string | null
  walletType: WalletType
  descriptorStr: string
  /** Set only for seed-signer sessions — needed to silently reconnect the software signer on reload. */
  seedMnemonic?: string
  sideswap?: boolean
}

export interface SavedApogeeSession {
  backend: 'apogee'
}

export type SavedSession = SavedLocalSession | SavedApogeeSession

export type WalletBackend = 'local' | 'apogee'
export type WalletSignerType = 'jade' | 'seed' | 'sideswap' | 'apogee'

// appLink is null for sign requests — the deep-link format for those isn't confirmed yet.
export interface PendingWalletRequest {
  kind: 'login' | 'sign'
  requestId: string
  appLink: string | null
}

export interface WalletState {
  backend: WalletBackend | null
  connectionStatus: ConnectionStatus
  connectorId: string | null
  walletType: WalletType | null
  signerType: WalletSignerType | null
  balances: Record<string, string>
  confirmedBalances: Record<string, string>
  pendingBalances: Record<string, string>
  /** Stable provider account identity; absent for the in-page wallet backends. */
  accountIdentifier: string | null
  chainId: string | null
  /** Persistence scope. This is an account id for Apogee and the stable script for local wallets. */
  walletScope: string | null
  /** Current lender-NFT owner scripts known to this wallet session. */
  portfolioScripts: string[]
  /** Provider balances do not currently distinguish confirmed and pending values. */
  hasBalanceBreakdown: boolean
  // Resolved once on connect; null until ready.
  receiveAddress: string | null
  scriptPubkey: string | null
  syncing: boolean
  reconnecting: boolean
  usbDeviceDetected: boolean
  pendingRequest: PendingWalletRequest | null
  /** Last error message. Persists even after isError is cleared. */
  error: string | null
  /** Whether the error should be shown to the user. Cleared on reconnect or new connect attempt. */
  isError: boolean
}

export const INITIAL_WALLET_STATE: WalletState = {
  backend: null,
  connectionStatus: 'disconnected',
  connectorId: null,
  walletType: null,
  signerType: null,
  balances: {},
  confirmedBalances: {},
  pendingBalances: {},
  accountIdentifier: null,
  chainId: null,
  walletScope: null,
  portfolioScripts: [],
  hasBalanceBreakdown: false,
  receiveAddress: null,
  scriptPubkey: null,
  syncing: false,
  reconnecting: false,
  usbDeviceDetected: false,
  pendingRequest: null,
  error: null,
  isError: false,
}
