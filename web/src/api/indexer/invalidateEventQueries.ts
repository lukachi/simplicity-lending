import type { QueryClient } from '@tanstack/react-query'

import { softAssertNever } from '@/utils/assert'
import { normalizeHex } from '@/utils/hex'

import type { IndexerEvent } from './events'
import { invalidateAllIndexerQueries } from './invalidateIndexerQueries'
import { borrowerQueryKeys, factoryQueryKeys, lenderQueryKeys, offersQueryKeys } from './queryKeys'

export interface InvalidateContext {
  queryClient: QueryClient
  scriptPubkeys: readonly string[]
}

function isOwnScript(eventScript: string, walletScripts: readonly string[]): boolean {
  const normalizedEventScript = normalizeHex(eventScript)
  return walletScripts.some(script => normalizeHex(script) === normalizedEventScript)
}

export function invalidateEventQueries(
  event: IndexerEvent,
  { queryClient, scriptPubkeys }: InvalidateContext,
): void {
  const invalidate = (queryKey: readonly unknown[]) => queryClient.invalidateQueries({ queryKey })

  switch (event.type) {
    case 'offer_created':
      invalidate(offersQueryKeys.lists())
      if (isOwnScript(event.borrower_script_pubkey, scriptPubkeys)) {
        invalidate(borrowerQueryKeys.all())
      }
      break
    case 'offer_status_updated':
      invalidate(offersQueryKeys.detail(event.id))
      invalidate(offersQueryKeys.lists())
      invalidate(offersQueryKeys.overview())
      invalidate(borrowerQueryKeys.all())
      invalidate(lenderQueryKeys.all())
      break
    case 'factory_created':
      if (isOwnScript(event.factory_auth_script_pubkey, scriptPubkeys)) {
        invalidate(factoryQueryKeys.byScript(event.factory_auth_script_pubkey))
      }
      break
    case 'block_indexed':
      invalidateAllIndexerQueries(queryClient)
      break

    default:
      softAssertNever(event)
  }
}
