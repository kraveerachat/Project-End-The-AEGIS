// src/components/NameEntryDialog.jsx — AEGIS Drive (IDEA1) · PR220-R2 · one name-entry dialog for Files and Vault
//
// Files' create-folder dialog is the visual source of truth. Every surface that asks for one
// name (Files New Folder, Vault New Folder / Rename) renders this primitive, so width, title,
// label, PillInput, focus, Enter handling and footer sizing cannot drift apart again.
//   • semantics stay with the caller: `canSubmit` and `problem` come from the caller's own
//     validation (Files: server codes; Vault: nameProblem + NFC/case-fold collisionKey)
//   • Enter submits only when `canSubmit` is true — the same gate as the disabled button
//   • no role branch: Admin, DataLake-User and any future account render the same thing
import { Modal, ModalClose, Field, PillInput, Btn } from './ui.jsx'

export function NameEntryDialog({
  open, onClose, onSubmit,
  id, title, label, submitLabel, cancelLabel, closeLabel,
  value, onChange, canSubmit, busy = false, problem = null,
  inputTestId, submitTestId, problemTestId,
}) {
  const submit = () => { if (canSubmit && !busy) onSubmit() }
  const titleId = `${id}-title`
  return (
    <Modal open={open} onClose={onClose} width={420} labelledBy={titleId}>
      <div data-name-entry-dialog="">
        <ModalClose onClose={onClose} label={closeLabel} />
        <h2 id={titleId} className="text-[18px] font-semibold text-ink">{title}</h2>
        <div className="mt-5">
          <Field id={id} label={label}>
            <PillInput
              id={id}
              data-testid={inputTestId}
              value={value}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit() } }}
              aria-invalid={problem ? 'true' : undefined}
              autoFocus
              disabled={busy}
            />
          </Field>
        </div>
        {problem && (
          <p data-testid={problemTestId} role="alert" className="text-[12.5px] font-medium mt-3" style={{ color: 'var(--danger)' }}>
            {problem}
          </p>
        )}
        <div data-name-entry-footer="" className="flex gap-2.5 mt-6">
          <Btn variant="outline" className="flex-1" onClick={onClose}>{cancelLabel}</Btn>
          <Btn variant="primary" className="flex-1" data-testid={submitTestId} onClick={submit} disabled={busy || !canSubmit}>
            {submitLabel}
          </Btn>
        </div>
      </div>
    </Modal>
  )
}
