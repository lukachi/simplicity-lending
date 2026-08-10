import type { OfferShort } from '@/api/indexer/schemas'

import { normalizeHex } from './hex'

export type ActorRole = 'lender' | 'borrower' | 'guest'

export function resolveActorRole(
  offer: OfferShort,
  walletScriptPubkeys: readonly string[],
  canAcceptOffers = false,
): ActorRole {
  const mine = new Set(walletScriptPubkeys.map(normalizeHex))
  const match = offer.participants.find(p => mine.has(normalizeHex(p.script_pubkey)))
  if (match) return match.participant_type
  if (offer.status === 'pending' && (walletScriptPubkeys.length > 0 || canAcceptOffers)) {
    return 'lender'
  }
  return 'guest'
}

export type OfferAction =
  | 'accept'
  | 'cancel'
  | 'repay'
  | 'claim-principal'
  | 'claim-interest'
  | 'liquidate'
  | 'none'

function isOfferExpired(offer: OfferShort, currentBlockHeight: number): boolean {
  return currentBlockHeight > offer.loan_expiration_height
}

function resolveLenderAction(offer: OfferShort, expired: boolean): OfferAction {
  switch (offer.status) {
    case 'pending':
      return expired ? 'none' : 'accept'
    case 'active':
      return expired ? 'liquidate' : 'none'
    case 'repaid':
      return 'claim-interest'
    default:
      return 'none'
  }
}

function resolveBorrowerAction(offer: OfferShort): OfferAction {
  switch (offer.status) {
    case 'pending':
      return 'cancel'
    case 'active':
      return offer.borrower_principal_utxo ? 'claim-principal' : 'repay'
    case 'liquidated':
      return offer.borrower_principal_utxo ? 'claim-principal' : 'none'
    default:
      return 'none'
  }
}

export function resolveOfferAction(
  offer: OfferShort,
  walletScriptPubkeys: readonly string[],
  currentBlockHeight: number,
  canAcceptOffers = false,
): OfferAction {
  const role = resolveActorRole(offer, walletScriptPubkeys, canAcceptOffers)
  const expired = isOfferExpired(offer, currentBlockHeight)

  switch (role) {
    case 'lender':
      return resolveLenderAction(offer, expired)
    case 'borrower':
      return resolveBorrowerAction(offer)
    case 'guest':
      return 'none'
  }
}
