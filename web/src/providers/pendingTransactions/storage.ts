import { type DBSchema, type IDBPDatabase, openDB } from 'idb'

import { normalizeHex } from '@/utils/hex'

import type { PendingTxRecord } from './types'

const DB_NAME = 'simplicity-lending:pending-transactions'
const DB_VERSION = 2
const STORE_NAME = 'pending-tx'
const LEGACY_WALLET_INDEX = 'by-wallet-script-pubkey'
const WALLET_SCOPE_INDEX = 'by-wallet-scope'

interface PendingTxDBSchema extends DBSchema {
  [STORE_NAME]: {
    key: string
    value: PendingTxRecord
    indexes: { [LEGACY_WALLET_INDEX]: string; [WALLET_SCOPE_INDEX]: string }
  }
}

let dbPromise: Promise<IDBPDatabase<PendingTxDBSchema>> | null = null

function getDb(): Promise<IDBPDatabase<PendingTxDBSchema>> {
  if (!dbPromise) {
    dbPromise = openDB<PendingTxDBSchema>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion, _newVersion, transaction) {
        const store =
          oldVersion < 1
            ? db.createObjectStore(STORE_NAME, { keyPath: 'txid' })
            : transaction.objectStore(STORE_NAME)
        if (oldVersion < 1) store.createIndex(LEGACY_WALLET_INDEX, 'walletScriptPubkey')
        if (oldVersion < 2) store.createIndex(WALLET_SCOPE_INDEX, 'walletScope')
      },
    })
  }
  return dbPromise
}

export async function loadPendingTxsForWallet(walletScope: string): Promise<PendingTxRecord[]> {
  const db = await getDb()
  const normalizedScope = normalizeWalletScope(walletScope)
  const scoped = await db.getAllFromIndex(STORE_NAME, WALLET_SCOPE_INDEX, normalizedScope)

  // Version 1 keyed local-wallet records only by script. Merge those records until they are
  // naturally replaced; provider account scopes can never collide with this hex-only index.
  if (!/^[0-9a-f]+$/.test(normalizedScope)) return scoped
  const legacy = (await db.getAllFromIndex(STORE_NAME, LEGACY_WALLET_INDEX, normalizedScope)).map(
    record => ({ ...record, walletScope: normalizedScope }),
  )
  return [...new Map([...legacy, ...scoped].map(record => [record.txid, record])).values()]
}

export async function putPendingTx(record: PendingTxRecord): Promise<void> {
  const db = await getDb()
  await db.put(STORE_NAME, {
    ...record,
    walletScope: normalizeWalletScope(record.walletScope),
    walletScriptPubkey: record.walletScriptPubkey
      ? normalizeHex(record.walletScriptPubkey)
      : undefined,
  })
}

export async function deletePendingTx(txid: string): Promise<void> {
  const db = await getDb()
  await db.delete(STORE_NAME, txid)
}

function normalizeWalletScope(scope: string): string {
  return scope.trim().toLowerCase()
}
