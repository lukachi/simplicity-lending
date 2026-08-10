import { useCallback } from 'react'

import type { OfferDetails } from '@/api/indexer/schemas'
import { getManifestTransactionSteps } from '@/components/TransactionStepper/transactionSteps'
import {
  deleteManifestAttempt,
  getManifestAttempt,
  markManifestAttemptBroadcast,
  putManifestAttempt,
} from '@/lib/liquid-provider/storage'
import { liquidProviderErrorCode } from '@/lib/liquid-provider/types'
import { useTxProgress } from '@/providers/txProgress/useTxProgress'
import { useWallet } from '@/providers/wallet/useWallet'
import {
  buildAcceptOfferManifestInvocation,
  recoverLenderPortfolioScript,
} from '@/simplicity/lending/apogee'

const DEFINITIVE_FAILURE_CODES = new Set([4001, 4200, 4901, -32602])

export function useApogeeAcceptOffer() {
  const { accountIdentifier, chainId, walletScope, executeTxManifest, addPortfolioScript } =
    useWallet()
  const { startTxProgress, setTxProgressError } = useTxProgress()

  const acceptOffer = useCallback(
    async (offer: OfferDetails): Promise<{ txid: string }> => {
      if (!accountIdentifier || !chainId || !walletScope) {
        throw new Error('Connect Apogee before accepting this offer.')
      }
      const advance = startTxProgress(getManifestTransactionSteps())
      try {
        const existing = await getManifestAttempt(walletScope, offer.id)
        const invocation =
          existing?.invocation ??
          buildAcceptOfferManifestInvocation({
            offer,
            requestId: crypto.randomUUID(),
            chainId,
            accountIdentifier,
          })
        if (!existing) {
          await putManifestAttempt({
            scope: walletScope,
            offerId: offer.id,
            lenderNftAssetId: offer.lender_nft_asset.toLowerCase(),
            invocation,
            createdAt: Date.now(),
          })
        }

        await advance('wallet')
        const result = await executeTxManifest(invocation)
        const attempt = await markManifestAttemptBroadcast(walletScope, offer.id, result.txid)
        try {
          const script = await recoverLenderPortfolioScript({ ...attempt, txid: result.txid })
          await addPortfolioScript(script)
        } catch (error) {
          // The txid is durable. The wallet provider retries recovery in the background.
          console.warn('Failed to record rotating lender script; recovery remains pending.', error)
        }
        return { txid: result.txid }
      } catch (error) {
        setTxProgressError(error)
        const code = liquidProviderErrorCode(error)
        if (code !== null && DEFINITIVE_FAILURE_CODES.has(code)) {
          await deleteManifestAttempt(walletScope, offer.id).catch(console.warn)
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

  return { acceptOffer }
}
