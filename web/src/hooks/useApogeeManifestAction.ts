import { useCallback } from 'react'

import { getManifestTransactionSteps } from '@/components/TransactionStepper/transactionSteps'
import {
  deleteManifestAttempt,
  getManifestAttempt,
  type ManifestAttemptRecord,
  markManifestAttemptBroadcast,
  putManifestAttempt,
} from '@/lib/liquid-provider/storage'
import {
  shouldAbandonTxManifestAttempt,
  type TxManifestInvocation,
} from '@/lib/liquid-provider/types'
import { useTxProgress } from '@/providers/txProgress/useTxProgress'
import { useWallet } from '@/providers/wallet/useWallet'
import { recoverManifestPortfolioScript } from '@/simplicity/lending/apogee'

type AttemptKind = NonNullable<ManifestAttemptRecord['attemptKind']>

export function useApogeeManifestAction() {
  const { accountIdentifier, chainId, walletScope, executeTxManifest, addPortfolioScript } =
    useWallet()
  const { startTxProgress, setTxProgressError } = useTxProgress()

  const execute = useCallback(
    async (input: {
      attemptId: string
      attemptKind: AttemptKind
      buildInvocation(identity: {
        requestId: string
        chainId: string
        accountIdentifier: string
      }): TxManifestInvocation | Promise<TxManifestInvocation>
      trackedOutputIndex?: number
      trackedAssetId?: string
    }): Promise<{ txid: string }> => {
      if (!accountIdentifier || !chainId || !walletScope) {
        throw new Error('Connect Apogee before executing this lending action.')
      }
      const advance = startTxProgress(getManifestTransactionSteps())
      try {
        const stored = await getManifestAttempt(walletScope, input.attemptId)
        const existing = stored?.attemptKind === input.attemptKind ? stored : undefined
        if (stored && !existing) await deleteManifestAttempt(walletScope, input.attemptId)
        const invocation =
          existing?.invocation ??
          (await input.buildInvocation({
            requestId: crypto.randomUUID(),
            chainId,
            accountIdentifier,
          }))
        if (!existing) {
          await putManifestAttempt({
            scope: walletScope,
            offerId: input.attemptId,
            attemptKind: input.attemptKind,
            invocation,
            trackedOutputIndex: input.trackedOutputIndex,
            trackedAssetId: input.trackedAssetId,
            createdAt: Date.now(),
          })
        }

        await advance('wallet')
        const result = await executeTxManifest(invocation)
        const attempt = await markManifestAttemptBroadcast(
          walletScope,
          input.attemptId,
          result.txid,
        )
        if (input.trackedOutputIndex !== undefined) {
          try {
            const script = await recoverManifestPortfolioScript({ ...attempt, txid: result.txid })
            await addPortfolioScript(script)
          } catch (error) {
            console.warn(
              'Failed to record rotating lending script; recovery remains pending.',
              error,
            )
          }
        } else {
          await deleteManifestAttempt(walletScope, input.attemptId).catch(console.warn)
        }
        return { txid: result.txid }
      } catch (error) {
        setTxProgressError(error)
        if (shouldAbandonTxManifestAttempt(error)) {
          await deleteManifestAttempt(walletScope, input.attemptId).catch(console.warn)
        }
        throw error
      }
    },
    [
      accountIdentifier,
      addPortfolioScript,
      chainId,
      executeTxManifest,
      setTxProgressError,
      startTxProgress,
      walletScope,
    ],
  )

  return { execute }
}
