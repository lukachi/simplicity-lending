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
import { buildClaimLenderVaultManifestInvocation } from '@/simplicity/lending/apogee'

const DEFINITIVE_FAILURE_CODES = new Set([4001, 4200, 4901, -32602])

export function useApogeeClaimLenderVault() {
  const { accountIdentifier, chainId, walletScope, executeTxManifest } = useWallet()
  const { startTxProgress, setTxProgressError } = useTxProgress()

  const claimLenderVault = useCallback(
    async (offer: OfferDetails): Promise<{ txid: string }> => {
      if (!accountIdentifier || !chainId || !walletScope) {
        throw new Error('Connect Apogee before collecting this repayment.')
      }
      const advance = startTxProgress(getManifestTransactionSteps())
      try {
        const stored = await getManifestAttempt(walletScope, offer.id)
        const existing = stored?.attemptKind === 'claim-lender-vault' ? stored : undefined
        if (stored && !existing) await deleteManifestAttempt(walletScope, offer.id)
        const invocation =
          existing?.invocation ??
          buildClaimLenderVaultManifestInvocation({
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
            attemptKind: 'claim-lender-vault',
            invocation,
            createdAt: Date.now(),
          })
        }

        await advance('wallet')
        const result = await executeTxManifest(invocation)
        await markManifestAttemptBroadcast(walletScope, offer.id, result.txid)
        await deleteManifestAttempt(walletScope, offer.id).catch(console.warn)
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
      chainId,
      executeTxManifest,
      setTxProgressError,
      startTxProgress,
      walletScope,
    ],
  )

  return { claimLenderVault }
}
