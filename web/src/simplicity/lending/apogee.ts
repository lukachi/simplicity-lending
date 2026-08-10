import { Transaction } from '@lilbonekit/lwk-web'

import { fetchTxRaw } from '@/api/esplora/methods'
import type { OfferDetails } from '@/api/indexer/schemas'
import { resolveLenderNftOutpoint, resolvePendingOutpoint } from '@/api/indexer/utils'
import {
  ACCEPT_OFFER_ACTION,
  SIMPLICITY_LENDING_V3_BUNDLE_HASH,
} from '@/lib/liquid-provider/apogee'
import {
  deleteManifestAttempt,
  loadBroadcastManifestAttempts,
  type ManifestAttemptRecord,
  rememberPortfolioScript,
} from '@/lib/liquid-provider/storage'
import type { TxManifestInvocation } from '@/lib/liquid-provider/types'
import { bytesToHex } from '@/utils/hex'

const ACCEPT_OFFER_MAX_FEE = '1000'
const LENDER_NFT_OUTPUT_INDEX = 2

function requireHex(value: string, label: string, bytes: number): string {
  const normalized = value.toLowerCase()
  if (!new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(normalized)) {
    throw new Error(`${label} must be ${bytes}-byte hex.`)
  }
  return normalized
}

function requireInteger(value: number, label: string): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be an integer.`)
  return String(value)
}

function parseOutpoint(value: string, label: string): { txid: string; vout: number } {
  const separator = value.lastIndexOf(':')
  if (separator === -1) throw new Error(`${label} is not a valid outpoint.`)
  const txid = requireHex(value.slice(0, separator), `${label} txid`, 32)
  const vout = Number(value.slice(separator + 1))
  if (!Number.isSafeInteger(vout) || vout < 0 || vout > 0xffffffff) {
    throw new Error(`${label} vout is invalid.`)
  }
  return { txid, vout }
}

export function buildAcceptOfferManifestInvocation(input: {
  offer: OfferDetails
  requestId: string
  chainId: string
  accountIdentifier: string
}): TxManifestInvocation {
  const { offer } = input
  const pendingOfferOutpoint = resolvePendingOutpoint(offer)
  const lenderNftOutpoint = resolveLenderNftOutpoint(offer)
  if (!pendingOfferOutpoint) throw new Error('Pending offer UTXO not found.')
  if (!lenderNftOutpoint) throw new Error('Lender NFT authorization UTXO not found.')

  return {
    protocolVersion: '0.1',
    requestId: input.requestId,
    chainId: input.chainId,
    accountIdentifier: input.accountIdentifier,
    manifest: { bundleHash: SIMPLICITY_LENDING_V3_BUNDLE_HASH },
    action: ACCEPT_OFFER_ACTION,
    arguments: {
      COLLATERAL_ASSET_ID: requireHex(offer.collateral_asset, 'Collateral asset id', 32),
      PRINCIPAL_ASSET_ID: requireHex(offer.principal_asset, 'Principal asset id', 32),
      BORROWER_NFT_ASSET_ID: requireHex(offer.borrower_nft_asset, 'Borrower NFT asset id', 32),
      LENDER_NFT_ASSET_ID: requireHex(offer.lender_nft_asset, 'Lender NFT asset id', 32),
      PROTOCOL_FEE_KEEPER_ASSET_ID: requireHex(
        offer.protocol_fee_keeper_asset,
        'Protocol fee keeper asset id',
        32,
      ),
      COLLATERAL_AMOUNT: offer.collateral_amount.toString(),
      PRINCIPAL_AMOUNT: offer.principal_amount.toString(),
      PRINCIPAL_INTEREST_RATE: requireInteger(offer.interest_rate, 'Interest rate'),
      LOAN_EXPIRATION_TIME: requireInteger(offer.loan_expiration_height, 'Loan expiration height'),
    },
    providedInputs: {
      pending_offer_in: parseOutpoint(pendingOfferOutpoint, 'Pending offer outpoint'),
      lender_nft_in: parseOutpoint(lenderNftOutpoint, 'Lender NFT outpoint'),
    },
    constraints: { maxFee: ACCEPT_OFFER_MAX_FEE },
  }
}

export async function recoverLenderPortfolioScript(
  attempt: ManifestAttemptRecord & { txid: string },
): Promise<string> {
  const transaction = Transaction.fromBytes(await fetchTxRaw(attempt.txid))
  const output = transaction.outputs[LENDER_NFT_OUTPUT_INDEX]
  if (!output) throw new Error('Acceptance transaction is missing the lender NFT output.')
  const asset = output.asset()?.toString()
  const amount = output.value()
  if (asset !== attempt.lenderNftAssetId || amount !== 1n) {
    throw new Error('Acceptance transaction lender NFT output does not match the accepted offer.')
  }
  const scriptPubkey = bytesToHex(output.scriptPubkey().bytes())
  if (!scriptPubkey) throw new Error('Acceptance transaction lender NFT script is empty.')

  await rememberPortfolioScript({
    scope: attempt.scope,
    scriptPubkey,
    offerId: attempt.offerId,
    txid: attempt.txid,
  })
  await deleteManifestAttempt(attempt.scope, attempt.offerId)
  return scriptPubkey
}

export async function recoverLenderPortfolioScripts(scope: string): Promise<string[]> {
  const attempts = await loadBroadcastManifestAttempts(scope)
  const recovered = await Promise.allSettled(
    attempts.map(attempt => recoverLenderPortfolioScript(attempt)),
  )
  return recovered.flatMap(result => (result.status === 'fulfilled' ? [result.value] : []))
}
