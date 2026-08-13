import assert from 'node:assert/strict'
import test from 'node:test'

import {
  findSupersedingTxid,
  getPendingTxFailureDescription,
  isSupersededByOfferStatus,
  parseConflictOutpoint,
} from '../src/providers/pendingTransactions/resolution.ts'

const ACTIVE_TXID = '11'.repeat(32)
const REPAY_TXID = '22'.repeat(32)
const LIQUIDATE_TXID = '33'.repeat(32)
const CONFLICT_OUTPOINT = `${ACTIVE_TXID}:2`

test('parses the persisted conflict outpoint', () => {
  assert.deepEqual(parseConflictOutpoint(CONFLICT_OUTPOINT), { txid: ACTIVE_TXID, vout: 2 })
  assert.equal(parseConflictOutpoint('not-an-outpoint'), null)
})

test('does not supersede a transaction that spent the conflict outpoint itself', () => {
  const outspends = [{ spent: false }, { spent: false }, { spent: true, txid: REPAY_TXID }]
  assert.equal(
    findSupersedingTxid({ txid: REPAY_TXID, conflictOutpoint: CONFLICT_OUTPOINT }, outspends),
    null,
  )
})

test('identifies the competing transaction that spent the conflict outpoint', () => {
  const outspends = [{ spent: false }, { spent: false }, { spent: true, txid: LIQUIDATE_TXID }]
  assert.equal(
    findSupersedingTxid({ txid: REPAY_TXID, conflictOutpoint: CONFLICT_OUTPOINT }, outspends),
    LIQUIDATE_TXID,
  )
})

test('recognizes both incompatible terminal offer states for legacy records', () => {
  assert.equal(isSupersededByOfferStatus({ kind: 'repay_offer' }, 'liquidated'), true)
  assert.equal(isSupersededByOfferStatus({ kind: 'liquidate_offer' }, 'repaid'), true)
  assert.equal(isSupersededByOfferStatus({ kind: 'liquidate_offer' }, 'claimed'), true)
  assert.equal(isSupersededByOfferStatus({ kind: 'repay_offer' }, 'repaid'), false)
  assert.equal(isSupersededByOfferStatus({ kind: 'liquidate_offer' }, 'liquidated'), false)
})

test('waits for authoritative outspend resolution when a conflict outpoint is persisted', () => {
  assert.equal(
    isSupersededByOfferStatus(
      { kind: 'repay_offer', conflictOutpoint: CONFLICT_OUTPOINT },
      'liquidated',
    ),
    false,
  )
  assert.equal(
    isSupersededByOfferStatus(
      { kind: 'liquidate_offer', conflictOutpoint: CONFLICT_OUTPOINT },
      'repaid',
    ),
    false,
  )
})

test('derives reload-safe supersession copy from structured persisted fields', () => {
  assert.equal(
    getPendingTxFailureDescription({
      kind: 'repay_offer',
      failureReason: 'superseded',
    }),
    'Repayment was superseded by liquidation.',
  )
  assert.equal(
    getPendingTxFailureDescription({
      kind: 'liquidate_offer',
      failureReason: 'superseded',
    }),
    'Liquidation was superseded by repayment.',
  )
})
