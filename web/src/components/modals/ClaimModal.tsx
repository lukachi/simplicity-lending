import { Chip } from '@heroui/react'
import { useMutation } from '@tanstack/react-query'
import { useMemo } from 'react'

import { fetchFeeRateSatPerKvb } from '@/api/esplora/fee'
import { fetchOffer } from '@/api/indexer/methods'
import type { OfferShort } from '@/api/indexer/schemas'
import { resolveLenderNftOutpoint, resolveRepaymentOutpoint } from '@/api/indexer/utils'
import OfferActionShell from '@/components/modals/OfferActionShell'
import OfferDetailsBody from '@/components/modals/OfferDetailsBody'
import { NETWORK_CONFIG } from '@/constants/network-config'
import { useApogeeClaimLenderVault } from '@/hooks/useApogeeClaimLenderVault'
import { useLenderVaultClaim } from '@/hooks/useLenderVaultClaim'
import { useStandardTransactionFlow } from '@/hooks/useStandardTransactionFlow'
import {
  estimateFeeBudgetSats,
  EXPLICIT_SIGNATURE_MAX_WEIGHT_TO_SATISFY,
  selectFeeUtxos,
  utxoToOutpointString,
} from '@/lwk/utxo'
import { useLwk } from '@/providers/lwk/useLwk'
import { usePendingTransactions } from '@/providers/pendingTransactions/usePendingTransactions'
import { useWallet } from '@/providers/wallet/useWallet'
import { ASSET_AUTH_VAULT_MAX_WEIGHT_TO_SATISFY } from '@/simplicity/asset-auth-vault/program'
import { formatAmount } from '@/utils/format'
import { calcInterest, computeProtocolFee } from '@/utils/offers'

const CLAIM_WEIGHT_UNITS =
  ASSET_AUTH_VAULT_MAX_WEIGHT_TO_SATISFY.WithdrawAll + EXPLICIT_SIGNATURE_MAX_WEIGHT_TO_SATISFY

interface ClaimModalProps {
  isOpen: boolean
  offer: OfferShort
  onClose: () => void
  onSuccess: () => void
}

export default function ClaimModal({ isOpen, offer, onClose, onSuccess }: ClaimModalProps) {
  const { principalAsset } = NETWORK_CONFIG
  const { backend, syncWallet, getBlindedWalletUtxos, scriptPubkey } = useWallet()
  const { lwkNetwork } = useLwk()
  const { claimLenderVault } = useLenderVaultClaim()
  const { claimLenderVault: claimLenderVaultWithApogee } = useApogeeClaimLenderVault()
  const runStandardTransactionFlow = useStandardTransactionFlow()
  const { addPendingTx } = usePendingTransactions()

  const claimVault = async () => {
    const fullOffer = await fetchOffer(offer.id)
    if (backend === 'apogee') return claimLenderVaultWithApogee(fullOffer)

    return runStandardTransactionFlow(async () => {
      const vaultOutpoint = resolveRepaymentOutpoint(fullOffer)
      if (!vaultOutpoint) throw new Error('Lender vault UTXO not found')

      const lenderNftOutpoint = resolveLenderNftOutpoint(fullOffer)
      if (!lenderNftOutpoint) throw new Error('Lender NFT UTXO not found')

      await syncWallet()
      const [blindedWalletUtxos, feeRate] = await Promise.all([
        getBlindedWalletUtxos(),
        fetchFeeRateSatPerKvb(),
      ])
      const feeBudgetSats = estimateFeeBudgetSats(CLAIM_WEIGHT_UNITS, feeRate)
      const feeUtxos = selectFeeUtxos(
        blindedWalletUtxos,
        lwkNetwork.policyAsset(),
        feeBudgetSats,
        feeRate,
      )

      return claimLenderVault({
        lenderVaultOutpoint: vaultOutpoint,
        lenderNftOutpoint,
        feeOutpoints: feeUtxos.map(utxoToOutpointString),
      })
    })
  }

  const { mutate, reset, data, status } = useMutation({
    mutationFn: claimVault,
    onSuccess: result => {
      void addPendingTx({
        txid: result.txid,
        kind: 'claim_interest',
        walletScriptPubkey: scriptPubkey ?? '',
        offerId: offer.id,
        previousOfferStatus: 'repaid',
        expectedOfferStatus: 'claimed',
      })
      if (backend === 'apogee') void syncWallet()
    },
  })

  const txSummary = useMemo(() => {
    const interestAmount = calcInterest(offer.principal_amount, offer.interest_rate)
    const protocolFeeAmount = computeProtocolFee(interestAmount)
    const netAmount = offer.principal_amount + interestAmount - protocolFeeAmount
    return [
      {
        label: 'Principal',
        value: `${formatAmount(offer.principal_amount, principalAsset.decimals)} ${principalAsset.symbol}`,
      },
      {
        label: 'Interest',
        value: `${formatAmount(interestAmount, principalAsset.decimals)} ${principalAsset.symbol}`,
      },
      {
        label: 'Protocol Fee',
        value: `-${formatAmount(protocolFeeAmount, principalAsset.decimals)} ${principalAsset.symbol}`,
      },
      {
        label: 'You Receive',
        value: `${formatAmount(netAmount, principalAsset.decimals)} ${principalAsset.symbol}`,
      },
    ]
  }, [offer, principalAsset])

  return (
    <OfferActionShell
      isOpen={isOpen}
      title='Claim Offer'
      chip={
        <Chip color='accent' variant='soft' size='sm'>
          Claim
        </Chip>
      }
      action={{
        label: 'Claim',
        variant: 'primary',
        eyebrow: 'Claim Vault',
        summary: txSummary,
        status,
        txid: data?.txid,
        onConfirm: () => mutate(),
      }}
      onClose={() => {
        reset()
        onClose()
      }}
      onSuccess={onSuccess}
    >
      <OfferDetailsBody offer={offer} />
    </OfferActionShell>
  )
}
