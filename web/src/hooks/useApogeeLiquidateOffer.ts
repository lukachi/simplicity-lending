import type { OfferDetails } from '@/api/indexer/schemas'
import { useApogeeManifestAction } from '@/hooks/useApogeeManifestAction'
import { buildLiquidateOfferManifestInvocation } from '@/simplicity/lending/apogee'

export function useApogeeLiquidateOffer() {
  const { execute } = useApogeeManifestAction()
  return {
    liquidateOffer: (offer: OfferDetails) =>
      execute({
        attemptId: offer.id,
        attemptKind: 'liquidate-offer',
        buildInvocation: identity => buildLiquidateOfferManifestInvocation({ ...identity, offer }),
      }),
  }
}
