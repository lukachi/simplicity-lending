import { type Pset, Registry, type Transaction, type Wollet } from '@lilbonekit/lwk-web'
import { useCallback, useEffect, useRef, useState } from 'react'

import { env } from '@/constants/env'
import { useSessionStorage } from '@/hooks/useSessionStorage'
import {
  connectApogee,
  disconnectApogee,
  executeApogeeTxManifest,
  getApogeeBalances,
  resumeApogee,
} from '@/lib/liquid-provider/apogee'
import { forgetApogeeProvider } from '@/lib/liquid-provider/discovery'
import { apogeeWalletScope, loadPortfolioScripts } from '@/lib/liquid-provider/storage'
import {
  isLiquidConnection,
  type LiquidConnection,
  type LiquidProvider,
  liquidProviderErrorCode,
  type TxManifestInvocation,
} from '@/lib/liquid-provider/types'
import { JadeBusyError, JadeDisconnectedError } from '@/lib/wallet-core/connector/errors'
import { JadeConnector } from '@/lib/wallet-core/connector/jade'
import { SeedConnector } from '@/lib/wallet-core/connector/seed'
import { SideSwapConnector } from '@/lib/wallet-core/connector/sideswap'
import type { WalletConnector } from '@/lib/wallet-core/connector/types'
import { createCachedWollet, type WalletCache } from '@/lib/wallet-core/store/walletCache'
import { DEFAULT_WALLET_TYPE, type WalletType } from '@/lib/wallet-core/types'
import {
  applyBroadcastTransaction,
  readWalletBalances,
  reconcilePendingBroadcasts,
  syncBalances,
} from '@/lib/wallet-core/wallet/sync'
import { createEsploraClient } from '@/lwk'
import { useLwk } from '@/providers/lwk/useLwk'
import { recoverLenderPortfolioScripts } from '@/simplicity/lending/apogee'
import { ErrorHandler } from '@/utils/errorHandler'

import {
  type CachePolicy,
  type ConnectOptions,
  INITIAL_WALLET_STATE,
  type SavedSession,
  type WalletSession,
  type WalletState,
} from './types'
import { WalletContext } from './WalletContext'

const SESSION_STORAGE_KEY = 'jade_wallet_session'
const BALANCE_POLL_INTERVAL_MS = 60_000
const MIN_SYNC_GAP_MS = 15_000
const MANIFEST_RECOVERY_POLL_MS = 15_000

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const { lwkNetwork, network } = useLwk()

  const sessionRef = useRef<WalletSession | null>(null)
  const apogeeSessionRef = useRef<{
    provider: LiquidProvider
    connection: LiquidConnection
    unsubscribe: () => void
  } | null>(null)
  const connectingRef = useRef(false)
  // Cancels the in-flight SideSwap login/sign request, if any.
  const pendingCancelRef = useRef<(() => Promise<void>) | null>(null)
  // Self-broadcast txs not yet confirmed per the indexer — reconciled after every full
  // scan so a stale scan can't silently undo their locally-applied effect.
  const pendingBroadcastsRef = useRef<Map<string, Transaction>>(new Map())
  // Invalidates stale connect() attempts and prevents duplicate disconnect handling.
  const connectionChangeCounterRef = useRef(0)
  // Registry metadata cache for signPset, keyed by the owned-asset set that seeded it.
  const registryRef = useRef<{ key: string; registry: Registry } | null>(null)
  // Throttle state shared by the poll, the focus/visibility handlers and manual syncs.
  const lastSyncAtRef = useRef(0)
  const syncInFlightRef = useRef(false)

  const [state, setState] = useState<WalletState>(INITIAL_WALLET_STATE)
  const [savedSession, setSavedSession] = useSessionStorage<SavedSession>(SESSION_STORAGE_KEY)

  useEffect(() => {
    if (state.backend !== 'apogee' || !state.walletScope) return
    const scope = state.walletScope
    let cancelled = false
    let recovering = false
    const recover = async () => {
      if (recovering) return
      recovering = true
      try {
        const scripts = await recoverLenderPortfolioScripts(scope)
        if (cancelled || scripts.length === 0) return
        setState(current => ({
          ...current,
          portfolioScripts: [...new Set([...current.portfolioScripts, ...scripts])].sort(),
        }))
      } catch (error) {
        console.warn('Failed to recover Apogee lender portfolio scripts.', error)
      } finally {
        recovering = false
      }
    }
    void recover()
    const id = setInterval(() => void recover(), MANIFEST_RECOVERY_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [state.backend, state.walletScope])

  const endSession = useCallback(
    async ({
      error,
      cachePolicy = 'preserve',
      disconnectProvider = true,
    }: {
      error?: string
      cachePolicy?: CachePolicy
      disconnectProvider?: boolean
    } = {}) => {
      connectionChangeCounterRef.current++
      const session = sessionRef.current
      sessionRef.current = null
      const apogeeSession = apogeeSessionRef.current
      apogeeSessionRef.current = null
      // A scan started by the ended session keeps running, and its own bookkeeping is skipped
      // as stale, so the flag is cleared here or the next session could never sync.
      syncInFlightRef.current = false
      // Reset UI immediately. Connector teardown runs in background and may hang if the device
      // was unplugged mid-session.
      session?.connector.disconnect().catch(console.warn)
      apogeeSession?.unsubscribe()
      if (disconnectProvider && apogeeSession) {
        disconnectApogee(apogeeSession.provider).catch(console.warn)
      }
      setSavedSession(null)
      setState(s => ({
        ...INITIAL_WALLET_STATE,
        usbDeviceDetected: s.usbDeviceDetected,
        error: error ?? null,
        isError: error !== undefined,
      }))
      const cache = session?.cache
      await (cachePolicy === 'clear' ? cache?.clearAndClose() : cache?.close())?.catch(console.warn)
    },
    [setSavedSession],
  )

  // Bump the counter (via endSession) before the network-bound cancel RPC, so the in-flight
  // connect()/signPset() sees it invalidated instead of racing this function's state reset.
  const cancelPendingRequest = useCallback(async () => {
    const cancel = pendingCancelRef.current
    pendingCancelRef.current = null
    await endSession()
    if (cancel) await cancel().catch(console.warn)
  }, [endSession])

  // Permanent Web Serial event listeners — detect USB plug/unplug.
  useEffect(() => {
    if (!('serial' in navigator)) return

    const handleConnect = () => {
      // Clear any prior disconnect error when the user re-plugs the device.
      setState(s => ({ ...s, usbDeviceDetected: true, error: null, isError: false }))
    }
    const handleDisconnect = () => {
      setState(s => ({ ...s, usbDeviceDetected: false }))
      // Covers disconnects during the PIN/unlock flow as well.
      // (waiting on the device's PIN entry) and hasn't set sessionRef.current yet.
      if (sessionRef.current || connectingRef.current) {
        const err = new JadeDisconnectedError()
        ErrorHandler.process(err)
        endSession({ error: err.message }).catch(console.warn)
      }
    }

    navigator.serial.addEventListener('connect', handleConnect)
    navigator.serial.addEventListener('disconnect', handleDisconnect)

    return () => {
      navigator.serial.removeEventListener('connect', handleConnect)
      navigator.serial.removeEventListener('disconnect', handleDisconnect)
    }
  }, [endSession])

  // Poll Jade state while connected — detects PIN lock and physical disconnect.
  useEffect(() => {
    if (state.connectionStatus === 'disconnected') return

    const id = setInterval(() => {
      const session = sessionRef.current
      if (!session || connectingRef.current) return

      session.connector
        .getConnectionStatus()
        .then(status => {
          if (status === 'locked' && state.connectionStatus !== 'locked') {
            // Force a clean reconnect so the PIN flow restarts from scratch.
            endSession().catch(console.warn)
            return
          }
          setState(s => (s.connectionStatus === status ? s : { ...s, connectionStatus: status }))
        })
        .catch((err: unknown) => {
          if (err instanceof JadeBusyError) return
          ErrorHandler.process(err)
          endSession({ error: new JadeDisconnectedError().message }).catch(console.warn)
        })
    }, 3_000)

    return () => clearInterval(id)
  }, [state.connectionStatus, endSession])

  useEffect(() => {
    if (state.connectionStatus !== 'ready') return

    const refreshBalances = () => {
      const session = sessionRef.current
      const apogeeSession = apogeeSessionRef.current
      if (!session && !apogeeSession) return
      // A scan re-downloads the whole history listing even when nothing changed, and a tab
      // activation fires both listeners below, so repeated triggers are collapsed here.
      if (syncInFlightRef.current) return
      if (Date.now() - lastSyncAtRef.current < MIN_SYNC_GAP_MS) return
      syncInFlightRef.current = true
      const attempt = connectionChangeCounterRef.current
      const refresh = apogeeSession
        ? getApogeeBalances(apogeeSession.provider, apogeeSession.connection).then(balances => ({
            total: balances,
            confirmed: balances,
            pending: {},
          }))
        : syncBalances(session!.wollet, session!.esploraClient).then(() => {
            const confirmedTxids = reconcilePendingBroadcasts(
              session!.wollet,
              pendingBroadcastsRef.current,
            )
            confirmedTxids.forEach(txid => pendingBroadcastsRef.current.delete(txid))
            return readWalletBalances(session!.wollet)
          })

      refresh
        .then(({ total, confirmed, pending }) => {
          if (attempt !== connectionChangeCounterRef.current) return
          setState(s => ({
            ...s,
            balances: total,
            confirmedBalances: confirmed,
            pendingBalances: pending,
          }))
        })
        .catch(error => {
          if (liquidProviderErrorCode(error) === 4900) {
            forgetApogeeProvider()
            const message = error instanceof Error ? error.message : String(error)
            void endSession({ error: message, disconnectProvider: false })
            return
          }
          console.warn(error)
        })
        .finally(() => {
          if (attempt !== connectionChangeCounterRef.current) return
          syncInFlightRef.current = false
          lastSyncAtRef.current = Date.now()
        })
    }

    const id = setInterval(refreshBalances, BALANCE_POLL_INTERVAL_MS)

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        refreshBalances()
      }
    }

    document.addEventListener('visibilitychange', handleVisibility)
    window.addEventListener('focus', refreshBalances)

    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', handleVisibility)
      window.removeEventListener('focus', refreshBalances)
    }
  }, [endSession, state.connectionStatus])

  const connect = useCallback(
    async (variant: WalletType, options?: ConnectOptions) => {
      if (sessionRef.current !== null || apogeeSessionRef.current !== null || connectingRef.current)
        return
      connectingRef.current = true
      const attempt = ++connectionChangeCounterRef.current

      const useApogee = options?.apogee === true
      const useSideSwap = options?.sideswap === true
      // seedMnemonic is a runtime choice from the demo-mode seed connect form; falling back to
      // VITE_DEBUG_MNEMONIC preserves the existing local-dev auto-connect behavior.
      const mnemonic = useSideSwap ? null : options?.seedMnemonic || env.VITE_DEBUG_MNEMONIC || null
      const isJade = !useSideSwap && mnemonic === null
      const signerType = useSideSwap ? 'sideswap' : isJade ? 'jade' : 'seed'
      setState(s => ({ ...s, syncing: true, error: null, isError: false }))

      let connector: WalletConnector | null = null
      let openedApogeeProvider: LiquidProvider | null = null
      // Set once the cache holds the cross-tab persist lock, so an attempt invalidated
      // after that point releases it instead of blocking the next connect.
      let openedCache: WalletCache | null = null
      try {
        if (useApogee) {
          if (network !== 'liquidtestnet') {
            throw new Error('Apogee TX Manifest lending is currently available only on testnet.')
          }
          const connected = options?.resumeOnly ? await resumeApogee() : await connectApogee()
          if (!connected) {
            setSavedSession(null)
            setState(s => ({ ...INITIAL_WALLET_STATE, usbDeviceDetected: s.usbDeviceDetected }))
            return
          }
          if (attempt !== connectionChangeCounterRef.current) return

          const { provider, connection } = connected
          openedApogeeProvider = provider
          const scope = apogeeWalletScope(connection.chainId, connection.accountIdentifier)
          const [balances, portfolioScripts] = await Promise.all([
            getApogeeBalances(provider, connection),
            loadPortfolioScripts(scope),
          ])
          if (attempt !== connectionChangeCounterRef.current) return

          const unsubscribe = provider.on({
            event: 'wallet_connectionChanged',
            listener: payload => {
              if (
                !isLiquidConnection(payload) ||
                payload.accountIdentifier !== connection.accountIdentifier ||
                payload.chainId !== connection.chainId ||
                !payload.permissions.methods.includes('experimental_executeTxManifest') ||
                !payload.permissions.methods.includes('getBalance')
              ) {
                void endSession({ disconnectProvider: false })
              }
            },
          })
          apogeeSessionRef.current = { provider, connection, unsubscribe }
          openedApogeeProvider = null
          setSavedSession({ backend: 'apogee' })
          setState(s => ({
            ...INITIAL_WALLET_STATE,
            usbDeviceDetected: s.usbDeviceDetected,
            backend: 'apogee',
            connectionStatus: 'ready',
            connectorId: 'apogee',
            signerType: 'apogee',
            balances,
            confirmedBalances: balances,
            pendingBalances: {},
            accountIdentifier: connection.accountIdentifier,
            chainId: connection.chainId,
            walletScope: scope,
            portfolioScripts,
            hasBalanceBreakdown: false,
            syncing: false,
          }))
          return
        }

        if (useSideSwap && !env.VITE_SIDESWAP_WS_URL) {
          throw new Error('VITE_SIDESWAP_WS_URL is not set')
        }

        const walletType: WalletType = isJade ? variant : DEFAULT_WALLET_TYPE

        connector = (() => {
          if (useSideSwap) return new SideSwapConnector(env.VITE_SIDESWAP_WS_URL!)
          if (mnemonic === null) return new JadeConnector(lwkNetwork)
          return new SeedConnector(lwkNetwork, mnemonic)
        })()

        await connector.connect()
        // The native 'connect' event only fires for a device that was already paired and
        // got replugged — a fresh pick-and-connect never triggers it.
        setState(s => ({ ...s, usbDeviceDetected: isJade, signerType }))
        const connectionStatus = await connector.getConnectionStatus()

        if (attempt !== connectionChangeCounterRef.current) {
          connector.disconnect().catch(console.warn)
          return
        }

        // Show 'locked' in the UI before getDescriptor() blocks waiting for Jade PIN.
        if (connectionStatus === 'locked') {
          setState(s => ({
            ...s,
            connectionStatus: 'locked',
            connectorId: connector!.id,
            walletType,
          }))
        }

        // resumeOnly: don't start a fresh login request nobody can see if there's no live session.
        if (options?.resumeOnly && connectionStatus !== 'ready') {
          connector.disconnect().catch(console.warn)
          sessionRef.current = null
          setState(s => ({ ...INITIAL_WALLET_STATE, usbDeviceDetected: s.usbDeviceDetected }))
          return
        }

        const request = await connector.getDescriptor(walletType)
        pendingCancelRef.current = request.cancel ?? null
        if (request.id) {
          const appLink = request.appLink ?? null
          setState(s => ({
            ...s,
            pendingRequest: { kind: 'login', requestId: request.id!, appLink },
          }))
          if (appLink) window.location.href = appLink
        }

        const descriptor = await request.result
        pendingCancelRef.current = null
        setState(s => (s.pendingRequest ? { ...s, pendingRequest: null } : s))

        if (attempt !== connectionChangeCounterRef.current) {
          connector.disconnect().catch(console.warn)
          return
        }

        if (connectionStatus === 'locked') {
          setState(s => ({ ...s, connectionStatus: 'disconnected' }))
        }

        const { wollet, cache } = await createCachedWollet(lwkNetwork, network, descriptor)
        openedCache = cache
        const esploraClient = createEsploraClient(lwkNetwork)

        sessionRef.current = { connector, descriptor, wollet, esploraClient, cache }

        const saved: SavedSession = {
          connectorId: connector.id,
          walletType,
          descriptorStr: descriptor.toString(),
          seedMnemonic: mnemonic ?? undefined,
          sideswap: useSideSwap,
        }
        setSavedSession(saved)

        const {
          total: balances,
          confirmed: confirmedBalances,
          pending: pendingBalances,
        } = await syncBalances(wollet, esploraClient)
        lastSyncAtRef.current = Date.now()
        if (attempt !== connectionChangeCounterRef.current) {
          openedCache.close().catch(console.warn)
          return
        }

        const address = wollet.address(0).address()
        const receiveAddress = address.toString()
        const scriptPubkey = address.scriptPubkey().toString()

        setState(s => ({
          ...s,
          backend: 'local',
          connectionStatus: 'ready',
          syncing: false,
          error: null,
          isError: false,
          balances,
          confirmedBalances,
          pendingBalances,
          receiveAddress,
          scriptPubkey,
          walletScope: scriptPubkey,
          portfolioScripts: [scriptPubkey],
          hasBalanceBreakdown: true,
        }))
      } catch (err) {
        openedCache?.close().catch(console.warn)
        openedApogeeProvider?.request({ method: 'wallet_disconnect' }).catch(console.warn)
        if (attempt !== connectionChangeCounterRef.current) {
          connector?.disconnect().catch(console.warn)
          return
        }
        if (liquidProviderErrorCode(err) === 4900) forgetApogeeProvider()
        ErrorHandler.process(err)
        const error = err instanceof Error ? err.message : String(err)
        // Not awaited — same hang risk as in disconnect(): update state immediately
        // instead of gating it behind the connector's own teardown.
        connector?.disconnect().catch(console.warn)
        sessionRef.current = null
        setState(s => ({
          ...INITIAL_WALLET_STATE,
          usbDeviceDetected: s.usbDeviceDetected,
          error,
          isError: true,
        }))
      } finally {
        connectingRef.current = false
      }
    },
    [endSession, lwkNetwork, network, setSavedSession],
  )

  const resumeSession = useCallback(async () => {
    if (!savedSession) return
    if (savedSession.backend === 'apogee') {
      await connect(DEFAULT_WALLET_TYPE, { apogee: true, resumeOnly: true })
      return
    }
    await connect(savedSession.walletType, {
      seedMnemonic: savedSession.seedMnemonic,
      sideswap: savedSession.sideswap,
      resumeOnly: savedSession.sideswap,
    })
  }, [savedSession, connect])

  const autoResumedRef = useRef(false)
  useEffect(() => {
    if (autoResumedRef.current || !savedSession || state.connectionStatus !== 'disconnected') return
    autoResumedRef.current = true
    setState(s => ({ ...s, reconnecting: true }))
    resumeSession()
      .catch(() => endSession().catch(console.warn))
      .finally(() => setState(s => ({ ...s, reconnecting: false })))
  }, [savedSession, state.connectionStatus, resumeSession, endSession])

  const sync = useCallback(async () => {
    const session = sessionRef.current
    const apogeeSession = apogeeSessionRef.current
    if (!session && !apogeeSession) throw new Error('WalletProvider: not connected')

    setState(s => ({ ...s, syncing: true, error: null }))
    // A manual sync follows a broadcast, so it runs regardless of the throttle, but still
    // feeds it so the poll doesn't repeat the same scan seconds later.
    syncInFlightRef.current = true
    const attempt = connectionChangeCounterRef.current

    try {
      if (apogeeSession) {
        const balances = await getApogeeBalances(apogeeSession.provider, apogeeSession.connection)
        if (attempt !== connectionChangeCounterRef.current) return
        setState(s => ({
          ...s,
          syncing: false,
          balances,
          confirmedBalances: balances,
          pendingBalances: {},
        }))
        return
      }
      if (!session) throw new Error('WalletProvider: local wallet session is missing')
      await syncBalances(session.wollet, session.esploraClient)
      if (attempt !== connectionChangeCounterRef.current) return

      const confirmedTxids = reconcilePendingBroadcasts(
        session.wollet,
        pendingBroadcastsRef.current,
      )
      confirmedTxids.forEach(txid => pendingBroadcastsRef.current.delete(txid))

      const {
        total: balances,
        confirmed: confirmedBalances,
        pending: pendingBalances,
      } = readWalletBalances(session.wollet)
      setState(s => ({ ...s, syncing: false, balances, confirmedBalances, pendingBalances }))
    } catch (err) {
      if (attempt !== connectionChangeCounterRef.current) return
      if (liquidProviderErrorCode(err) === 4900) {
        forgetApogeeProvider()
        const error = err instanceof Error ? err.message : String(err)
        await endSession({ error, disconnectProvider: false })
        return
      }
      ErrorHandler.process(err)
      const error = err instanceof Error ? err.message : String(err)
      setState(s => ({ ...s, syncing: false, error, isError: true }))
    } finally {
      if (attempt === connectionChangeCounterRef.current) {
        syncInFlightRef.current = false
        lastSyncAtRef.current = Date.now()
      }
    }
  }, [endSession])

  // Best-effort local UI update — the tx already broadcast successfully regardless of
  // this outcome, so failures here (e.g. a full scan racing this call) must not throw.
  const applyBroadcastTx = useCallback((tx: Transaction) => {
    const session = sessionRef.current
    if (!session) return

    try {
      const { total, confirmed, pending } = applyBroadcastTransaction(session.wollet, tx)
      pendingBroadcastsRef.current.set(tx.txid().toString(), tx)
      setState(s => ({
        ...s,
        balances: total,
        confirmedBalances: confirmed,
        pendingBalances: pending,
      }))
    } catch (err) {
      console.warn(err)
    }
  }, [])

  /**
   * Embed ELIP-0100 asset metadata (contract + issuance prevout) into the PSET
   * for every registry-registered asset the wallet owns.
   */
  const withAssetContracts = useCallback(
    async (pset: Pset, wollet: Wollet): Promise<Pset> => {
      try {
        const owned = wollet.assetsOwned()
        const key = owned.toString()
        if (registryRef.current?.key !== key) {
          const registry = await Registry.defaultForNetwork(lwkNetwork, owned)
          registryRef.current?.registry.free()
          registryRef.current = { key, registry }
        }
        return registryRef.current.registry.addContracts(pset)
      } catch (error) {
        console.warn('Signing without asset metadata (registry unavailable):', error)
        return pset
      }
    },
    [lwkNetwork],
  )

  const signPset = useCallback(
    async (pset: Pset): Promise<Pset> => {
      const session = sessionRef.current
      if (!session) throw new Error('WalletProvider: not connected')

      const request = await session.connector.signPset(
        await withAssetContracts(pset, session.wollet),
      )
      if (!request.id) return request.result

      pendingCancelRef.current = request.cancel ?? null
      setState(s => ({
        ...s,
        pendingRequest: {
          kind: 'sign',
          requestId: request.id!,
          appLink: request.appLink ?? null,
        },
      }))

      try {
        return await request.result
      } finally {
        pendingCancelRef.current = null
        setState(s => (s.pendingRequest ? { ...s, pendingRequest: null } : s))
      }
    },
    [withAssetContracts],
  )

  // Returns the snapshot derived once on connect — single source of truth for the
  // deterministic address(0). Live wollet/utxos still come from get* below.
  const getReceiveAddress = useCallback(
    async (): Promise<string | null> => state.receiveAddress,
    [state.receiveAddress],
  )

  const verifyReceiveAddress = useCallback(async (): Promise<string> => {
    const session = sessionRef.current
    if (!session) throw new Error('WalletProvider: not connected')
    if (!session.connector.getVerifiedReceiveAddress)
      return session.wollet.address(0).address().toString()

    return session.connector.getVerifiedReceiveAddress(
      state.walletType ?? DEFAULT_WALLET_TYPE,
      session.wollet,
    )
  }, [state.walletType])

  const getBlindedWalletUtxos = useCallback(async () => {
    const session = sessionRef.current

    if (!session) {
      throw new Error('WalletProvider: not connected')
    }

    // LWK returns blinded UTXOs, which are spendable by LWK
    return session.wollet.utxos()
  }, [])

  const getWollet = useCallback(async (): Promise<Wollet> => {
    const session = sessionRef.current
    if (!session) throw new Error('WalletProvider: not connected')

    return session.wollet
  }, [])

  const executeTxManifest = useCallback(async (invocation: TxManifestInvocation) => {
    const session = apogeeSessionRef.current
    if (!session) throw new Error('Connect Apogee before executing this lending action.')
    if (
      invocation.chainId !== session.connection.chainId ||
      invocation.accountIdentifier !== session.connection.accountIdentifier
    ) {
      throw new Error('The lending request does not match the connected Apogee account.')
    }
    try {
      return await executeApogeeTxManifest(session.provider, invocation)
    } catch (error) {
      if ((error as { code?: unknown })?.code === 4900) forgetApogeeProvider()
      throw error
    }
  }, [])

  const addPortfolioScript = useCallback(async (scriptPubkey: string) => {
    const normalized = scriptPubkey.toLowerCase()
    setState(s =>
      s.portfolioScripts.includes(normalized)
        ? s
        : { ...s, portfolioScripts: [...s.portfolioScripts, normalized].sort() },
    )
  }, [])

  return (
    <WalletContext.Provider
      value={{
        ...state,
        isReady: state.connectionStatus === 'ready',
        connect,
        cancelPendingRequest,
        disconnect: endSession,
        syncWallet: sync,
        applyBroadcastTransaction: applyBroadcastTx,
        signPset,
        getReceiveAddress,
        verifyReceiveAddress,
        getWollet,
        getBlindedWalletUtxos,
        executeTxManifest,
        addPortfolioScript,
      }}
    >
      {children}
    </WalletContext.Provider>
  )
}
