import type { EsploraOutspend } from '@/api/esplora/schemas'
import type { OfferStatus } from '@/api/indexer/schemas'

import type { PendingTxRecord } from './types'

const TXID_PATTERN = /^[0-9a-f]{64}$/i

export interface ParsedOutpoint {
  txid: string
  vout: number
}

export function parseConflictOutpoint(outpoint: string | undefined): ParsedOutpoint | null {
  if (!outpoint) return null
  const separator = outpoint.lastIndexOf(':')
  if (separator <= 0) return null

  const txid = outpoint.slice(0, separator).toLowerCase()
  const voutText = outpoint.slice(separator + 1)
  const vout = Number(voutText)
  if (!TXID_PATTERN.test(txid) || !/^\d+$/.test(voutText) || !Number.isSafeInteger(vout)) {
    return null
  }

  return { txid, vout }
}

export function findSupersedingTxid(
  record: Pick<PendingTxRecord, 'txid' | 'conflictOutpoint'>,
  outspends: EsploraOutspend[],
): string | null {
  const outpoint = parseConflictOutpoint(record.conflictOutpoint)
  if (!outpoint) return null

  const spender = outspends[outpoint.vout]
  const spendingTxid = spender?.spent && spender.txid?.toLowerCase()
  if (!spendingTxid || !TXID_PATTERN.test(spendingTxid)) return null
  return spendingTxid === record.txid.toLowerCase() ? null : spendingTxid
}

export function hasReachedOfferStatus(current: OfferStatus, expected: OfferStatus): boolean {
  if (current === expected) return true
  if (expected === 'active') {
    return current === 'repaid' || current === 'liquidated' || current === 'claimed'
  }
  if (expected === 'repaid') return current === 'claimed'
  return false
}

/** Fallback for records saved before `conflictOutpoint` was introduced. */
export function isSupersededByOfferStatus(
  record: Pick<PendingTxRecord, 'kind' | 'conflictOutpoint'>,
  current: OfferStatus,
): boolean {
  // Modern records must be resolved from the actual outspend so the winner's
  // txid is persisted atomically with the superseded state. Otherwise a faster
  // indexer response can mark the record failed first and stop outspend polling.
  if (record.conflictOutpoint) return false
  if (record.kind === 'repay_offer') return current === 'liquidated'
  if (record.kind === 'liquidate_offer') return current === 'repaid' || current === 'claimed'
  return false
}

export function getPendingTxFailureDescription(
  record: Pick<PendingTxRecord, 'kind' | 'failureReason' | 'errorMessage'>,
): string {
  if (record.failureReason === 'superseded') {
    if (record.kind === 'repay_offer') return 'Repayment was superseded by liquidation.'
    if (record.kind === 'liquidate_offer') return 'Liquidation was superseded by repayment.'
    return 'Transaction was superseded by another transaction.'
  }
  return record.errorMessage ?? "Couldn't confirm this transaction."
}
