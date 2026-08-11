import { type DBSchema, type IDBPDatabase, openDB } from 'idb'

import type { TxManifestInvocation } from './types'

const DB_NAME = 'simplicity-lending:apogee'
const DB_VERSION = 1
const PORTFOLIO_STORE = 'portfolio-scripts'
const ATTEMPT_STORE = 'manifest-attempts'
const BY_SCOPE = 'by-scope'

export interface ManifestAttemptRecord {
  key: string
  scope: string
  offerId: string
  lenderNftAssetId?: string
  trackedAssetId?: string
  trackedOutputIndex?: number
  attemptKind?:
    | 'accept-offer'
    | 'claim-lender-vault'
    | 'create-factory'
    | 'create-offer'
    | 'claim-principal'
    | 'cancel-offer'
    | 'repay-loan'
    | 'liquidate-offer'
  invocation: TxManifestInvocation
  createdAt: number
  txid?: string
}

export type BroadcastManifestAttemptRecord = ManifestAttemptRecord & { txid: string }

interface PortfolioScriptRecord {
  key: string
  scope: string
  scriptPubkey: string
  offerId: string
  txid: string
  createdAt: number
}

interface ApogeeDBSchema extends DBSchema {
  [PORTFOLIO_STORE]: {
    key: string
    value: PortfolioScriptRecord
    indexes: { [BY_SCOPE]: string }
  }
  [ATTEMPT_STORE]: {
    key: string
    value: ManifestAttemptRecord
    indexes: { [BY_SCOPE]: string }
  }
}

let dbPromise: Promise<IDBPDatabase<ApogeeDBSchema>> | null = null

function getDb(): Promise<IDBPDatabase<ApogeeDBSchema>> {
  if (!dbPromise) {
    dbPromise = openDB<ApogeeDBSchema>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        const scripts = db.createObjectStore(PORTFOLIO_STORE, { keyPath: 'key' })
        scripts.createIndex(BY_SCOPE, 'scope')
        const attempts = db.createObjectStore(ATTEMPT_STORE, { keyPath: 'key' })
        attempts.createIndex(BY_SCOPE, 'scope')
      },
    })
  }
  return dbPromise
}

export function apogeeWalletScope(chainId: string, accountIdentifier: string): string {
  return `apogee:${chainId}:${accountIdentifier}`
}

function attemptKey(scope: string, offerId: string): string {
  return `${scope}:offer:${offerId}`
}

export async function loadPortfolioScripts(scope: string): Promise<string[]> {
  const db = await getDb()
  const records = await db.getAllFromIndex(PORTFOLIO_STORE, BY_SCOPE, scope)
  return [...new Set(records.map(record => record.scriptPubkey))].sort()
}

export async function rememberPortfolioScript(input: {
  scope: string
  scriptPubkey: string
  offerId: string
  txid: string
}): Promise<void> {
  const db = await getDb()
  const scriptPubkey = input.scriptPubkey.toLowerCase()
  await db.put(PORTFOLIO_STORE, {
    ...input,
    scriptPubkey,
    key: `${input.scope}:script:${scriptPubkey}`,
    createdAt: Date.now(),
  })
}

export async function getManifestAttempt(
  scope: string,
  offerId: string,
): Promise<ManifestAttemptRecord | undefined> {
  const db = await getDb()
  return db.get(ATTEMPT_STORE, attemptKey(scope, offerId))
}

export async function putManifestAttempt(
  record: Omit<ManifestAttemptRecord, 'key'>,
): Promise<void> {
  const db = await getDb()
  await db.put(ATTEMPT_STORE, { ...record, key: attemptKey(record.scope, record.offerId) })
}

export async function markManifestAttemptBroadcast(
  scope: string,
  offerId: string,
  txid: string,
): Promise<ManifestAttemptRecord> {
  const db = await getDb()
  const key = attemptKey(scope, offerId)
  const record = await db.get(ATTEMPT_STORE, key)
  if (!record) throw new Error('Manifest attempt disappeared before its result was persisted.')
  const updated = { ...record, txid }
  await db.put(ATTEMPT_STORE, updated)
  return updated
}

export async function loadBroadcastManifestAttempts(
  scope: string,
): Promise<BroadcastManifestAttemptRecord[]> {
  const db = await getDb()
  const records = await db.getAllFromIndex(ATTEMPT_STORE, BY_SCOPE, scope)
  return records.filter((record): record is BroadcastManifestAttemptRecord => !!record.txid)
}

export async function deleteManifestAttempt(scope: string, offerId: string): Promise<void> {
  const db = await getDb()
  await db.delete(ATTEMPT_STORE, attemptKey(scope, offerId))
}
