import { useMutation } from '@tanstack/react-query'

import UserIcon from '@/components/icons/UserIcon'
import TransactionModal from '@/components/TransactionModal'
import { UiButton } from '@/components/ui/UiButton'
import { UiModal } from '@/components/ui/UiModal'
import { useApogeeBorrowerActions } from '@/hooks/useApogeeBorrowerActions'
import { useBorrowerAccount } from '@/hooks/useBorrowerAccount'
import { useFreezeViewWhileOpen } from '@/hooks/useFreezeViewWhileOpen'
import { useStandardTransactionFlow } from '@/hooks/useStandardTransactionFlow'
import { usePendingTransactions } from '@/providers/pendingTransactions/usePendingTransactions'
import { useWallet } from '@/providers/wallet/useWallet'

interface CreateBorrowerAccountModalProps {
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  onClose: () => void
}

export default function CreateBorrowerAccountModal({
  isOpen,
  onOpenChange,
  onClose,
}: CreateBorrowerAccountModalProps) {
  const { createBorrowerAccount, refetchFactory, scriptPubkey } = useBorrowerAccount()
  const { enableBorrowing } = useApogeeBorrowerActions()
  const { backend } = useWallet()
  const runStandardTransactionFlow = useStandardTransactionFlow()
  const { addPendingTx, addSurfaceToast } = usePendingTransactions()
  const { mutate, reset, data, status } = useMutation({
    mutationFn: () =>
      backend === 'apogee' ? enableBorrowing() : runStandardTransactionFlow(createBorrowerAccount),
    onSuccess: result => {
      void addPendingTx({
        txid: result.txid,
        kind: 'create_borrower_account',
        ...(scriptPubkey ? { walletScriptPubkey: scriptPubkey } : {}),
      })
    },
  })

  const liveTxid = data?.txid ?? null
  const view = useFreezeViewWhileOpen(isOpen, {
    status,
    txid: liveTxid,
  })

  const handleClose = () => {
    if (data?.txid) addSurfaceToast(data.txid)
    reset()
    onOpenChange(false)
    refetchFactory()
    onClose()
  }

  if (view.status !== 'idle') {
    return (
      <TransactionModal
        isOpen={isOpen}
        eyebrow='Enable Borrowing'
        status={view.status}
        txid={view.txid}
        onClose={handleClose}
      />
    )
  }

  return (
    <UiModal
      isOpen={isOpen}
      onOpenChange={open => {
        if (!open) handleClose()
      }}
      title={
        <span className='flex items-center gap-3'>
          <span className='bg-accent-soft text-accent-soft-foreground flex size-10 items-center justify-center rounded-full'>
            <UserIcon className='size-5' />
          </span>
          Enable Borrowing
        </span>
      }
      footer={
        <>
          <UiButton variant='secondary' onPress={handleClose}>
            Cancel
          </UiButton>
          <UiButton
            variant='primary'
            onPress={() => {
              mutate()
            }}
          >
            Enable
          </UiButton>
        </>
      }
    >
      <p className='text-muted text-sm'>
        Creates the reusable on-chain capability this wallet needs to publish borrow offers.
      </p>
    </UiModal>
  )
}
