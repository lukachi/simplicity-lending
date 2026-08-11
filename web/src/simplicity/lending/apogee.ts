import { Transaction } from '@lilbonekit/lwk-web'

import { fetchTxRaw } from '@/api/esplora/methods'
import type { OfferDetails } from '@/api/indexer/schemas'
import {
  resolveActiveOutpoint,
  resolveBorrowerNftOutpoint,
  resolveLenderNftOutpoint,
  resolvePendingOutpoint,
  resolveRepaymentOutpoint,
  toOutpoint,
} from '@/api/indexer/utils'
import {
  ACCEPT_OFFER_ACTION,
  CANCEL_OFFER_ACTION,
  CLAIM_LENDER_VAULT_ACTION,
  CLAIM_PRINCIPAL_ACTION,
  CREATE_FACTORY_ACTION,
  CREATE_OFFER_ACTION,
  LIQUIDATE_OFFER_ACTION,
  REPAY_LOAN_ACTION,
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
const CLAIM_LENDER_VAULT_MAX_FEE = '1000'
const BORROWER_ACTION_MAX_FEE = '1000'
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
    arguments: buildLendingInstanceArguments(offer),
    providedInputs: {
      pending_offer_in: parseOutpoint(pendingOfferOutpoint, 'Pending offer outpoint'),
      lender_nft_in: parseOutpoint(lenderNftOutpoint, 'Lender NFT outpoint'),
    },
    constraints: { maxFee: ACCEPT_OFFER_MAX_FEE },
  }
}

export function buildClaimLenderVaultManifestInvocation(input: {
  offer: OfferDetails
  requestId: string
  chainId: string
  accountIdentifier: string
}): TxManifestInvocation {
  const { offer } = input
  const lenderVaultOutpoint = resolveRepaymentOutpoint(offer)
  const lenderNftOutpoint = resolveLenderNftOutpoint(offer)
  if (!lenderVaultOutpoint) throw new Error('Lender vault UTXO not found.')
  if (!lenderNftOutpoint) throw new Error('Lender NFT UTXO not found.')

  return {
    protocolVersion: '0.1',
    requestId: input.requestId,
    chainId: input.chainId,
    accountIdentifier: input.accountIdentifier,
    manifest: { bundleHash: SIMPLICITY_LENDING_V3_BUNDLE_HASH },
    action: CLAIM_LENDER_VAULT_ACTION,
    arguments: buildLendingInstanceArguments(offer),
    providedInputs: {
      lender_vault_in: parseOutpoint(lenderVaultOutpoint, 'Lender vault outpoint'),
      lender_nft_in: parseOutpoint(lenderNftOutpoint, 'Lender NFT outpoint'),
    },
    constraints: { maxFee: CLAIM_LENDER_VAULT_MAX_FEE },
  }
}

type InvocationIdentity = {
  requestId: string
  chainId: string
  accountIdentifier: string
}

function invocationBase(
  input: InvocationIdentity,
  action: string,
): Omit<TxManifestInvocation, 'arguments' | 'providedInputs'> {
  return {
    protocolVersion: '0.1',
    requestId: input.requestId,
    chainId: input.chainId,
    accountIdentifier: input.accountIdentifier,
    manifest: { bundleHash: SIMPLICITY_LENDING_V3_BUNDLE_HASH },
    action,
    constraints: { maxFee: BORROWER_ACTION_MAX_FEE },
  }
}

export function buildCreateFactoryManifestInvocation(
  input: InvocationIdentity,
): TxManifestInvocation {
  return {
    ...invocationBase(input, CREATE_FACTORY_ACTION),
    arguments: {},
    providedInputs: {},
  }
}

export function buildCreateOfferManifestInvocation(
  input: InvocationIdentity & {
    factoryAssetId: string
    factoryAuthOutpoint: string
    issuanceFactoryOutpoint: string
    collateralAssetId: string
    collateralAmount: bigint
    principalAssetId: string
    principalAmount: bigint
    principalInterestRate: number
    loanExpirationHeight: number
    protocolFeeKeeperAssetId: string
  },
): TxManifestInvocation {
  return {
    ...invocationBase(input, CREATE_OFFER_ACTION),
    arguments: {
      FACTORY_ASSET_ID: requireHex(input.factoryAssetId, 'Factory asset id', 32),
      COLLATERAL_ASSET_ID: requireHex(input.collateralAssetId, 'Collateral asset id', 32),
      PRINCIPAL_ASSET_ID: requireHex(input.principalAssetId, 'Principal asset id', 32),
      PROTOCOL_FEE_KEEPER_ASSET_ID: requireHex(
        input.protocolFeeKeeperAssetId,
        'Protocol fee keeper asset id',
        32,
      ),
      COLLATERAL_AMOUNT: input.collateralAmount.toString(),
      PRINCIPAL_AMOUNT: input.principalAmount.toString(),
      PRINCIPAL_INTEREST_RATE: requireInteger(input.principalInterestRate, 'Interest rate'),
      LOAN_EXPIRATION_TIME: requireInteger(input.loanExpirationHeight, 'Loan expiration height'),
    },
    providedInputs: {
      factory_auth_in: parseOutpoint(input.factoryAuthOutpoint, 'Factory auth outpoint'),
      factory_covenant_in: parseOutpoint(
        input.issuanceFactoryOutpoint,
        'Factory covenant outpoint',
      ),
    },
  }
}

export function buildClaimPrincipalManifestInvocation(
  input: InvocationIdentity & {
    offer: OfferDetails
  },
): TxManifestInvocation {
  const principal = input.offer.borrower_principal_utxo
  const borrowerNft = resolveBorrowerNftOutpoint(input.offer)
  if (!principal) throw new Error('Borrower principal UTXO not found.')
  if (!borrowerNft) throw new Error('Borrower NFT UTXO not found.')
  return {
    ...invocationBase(input, CLAIM_PRINCIPAL_ACTION),
    arguments: buildLendingInstanceArguments(input.offer),
    providedInputs: {
      principal_asset_auth_in: parseOutpoint(toOutpoint(principal), 'Principal outpoint'),
      borrower_nft_in: parseOutpoint(borrowerNft, 'Borrower NFT outpoint'),
    },
  }
}

export function buildCancelOfferManifestInvocation(
  input: InvocationIdentity & {
    offer: OfferDetails
  },
): TxManifestInvocation {
  const pending = resolvePendingOutpoint(input.offer)
  const lenderNft = resolveLenderNftOutpoint(input.offer)
  const borrowerNft = resolveBorrowerNftOutpoint(input.offer)
  if (!pending || !lenderNft || !borrowerNft)
    throw new Error('Offer cancellation inputs not found.')
  return {
    ...invocationBase(input, CANCEL_OFFER_ACTION),
    arguments: buildLendingInstanceArguments(input.offer),
    providedInputs: {
      pending_offer_in: parseOutpoint(pending, 'Pending offer outpoint'),
      lender_nft_in: parseOutpoint(lenderNft, 'Lender NFT outpoint'),
      borrower_nft_in: parseOutpoint(borrowerNft, 'Borrower NFT outpoint'),
    },
  }
}

export function buildRepayLoanManifestInvocation(
  input: InvocationIdentity & {
    offer: OfferDetails
  },
): TxManifestInvocation {
  const active = resolveActiveOutpoint(input.offer)
  const borrowerNft = resolveBorrowerNftOutpoint(input.offer)
  if (!active || !borrowerNft) throw new Error('Loan repayment inputs not found.')
  return {
    ...invocationBase(input, REPAY_LOAN_ACTION),
    arguments: buildLendingInstanceArguments(input.offer),
    providedInputs: {
      active_offer_in: parseOutpoint(active, 'Active offer outpoint'),
      borrower_nft_in: parseOutpoint(borrowerNft, 'Borrower NFT outpoint'),
    },
  }
}

export function buildLiquidateOfferManifestInvocation(
  input: InvocationIdentity & {
    offer: OfferDetails
  },
): TxManifestInvocation {
  const active = resolveActiveOutpoint(input.offer)
  const lenderNft = resolveLenderNftOutpoint(input.offer)
  if (!active || !lenderNft) throw new Error('Loan liquidation inputs not found.')
  return {
    ...invocationBase(input, LIQUIDATE_OFFER_ACTION),
    arguments: buildLendingInstanceArguments(input.offer),
    providedInputs: {
      active_offer_in: parseOutpoint(active, 'Active offer outpoint'),
      lender_nft_in: parseOutpoint(lenderNft, 'Lender NFT outpoint'),
    },
  }
}

export function buildLendingInstanceArguments(offer: OfferDetails): Record<string, string> {
  return {
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
  }
}

export async function recoverLenderPortfolioScript(
  attempt: ManifestAttemptRecord & { txid: string },
): Promise<string> {
  return recoverManifestPortfolioScript(attempt)
}

export async function recoverManifestPortfolioScript(
  attempt: ManifestAttemptRecord & { txid: string },
): Promise<string> {
  const transaction = Transaction.fromBytes(await fetchTxRaw(attempt.txid))
  const outputIndex = attempt.trackedOutputIndex ?? LENDER_NFT_OUTPUT_INDEX
  const output = transaction.outputs[outputIndex]
  if (!output) throw new Error('Manifest transaction is missing the tracked wallet output.')
  const asset = output.asset()?.toString()
  const amount = output.value()
  const expectedAsset = attempt.trackedAssetId ?? attempt.lenderNftAssetId
  if ((expectedAsset && asset !== expectedAsset) || amount !== 1n) {
    throw new Error('Manifest transaction wallet output does not match the approved action.')
  }
  const scriptPubkey = bytesToHex(output.scriptPubkey().bytes())
  if (!scriptPubkey) throw new Error('Manifest transaction wallet script is empty.')

  await rememberPortfolioScript({
    scope: attempt.scope,
    scriptPubkey,
    offerId: attempt.offerId,
    txid: attempt.txid,
  })
  await deleteManifestAttempt(attempt.scope, attempt.offerId)
  return scriptPubkey
}

export async function recoverManifestPortfolioScripts(scope: string): Promise<string[]> {
  const attempts = (await loadBroadcastManifestAttempts(scope)).filter(attempt => {
    const kind = attempt.attemptKind ?? 'accept-offer'
    return kind === 'accept-offer' || attempt.trackedOutputIndex !== undefined
  })
  const recovered = await Promise.allSettled(
    attempts.map(attempt => recoverManifestPortfolioScript(attempt)),
  )
  return recovered.flatMap(result => (result.status === 'fulfilled' ? [result.value] : []))
}
