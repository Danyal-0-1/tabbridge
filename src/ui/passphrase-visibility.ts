function setVisibility(input: HTMLInputElement, button: HTMLButtonElement, visible: boolean): void {
  const action = visible ? 'Hide' : 'Show';
  const fieldLabel = button.dataset.passphraseLabel ?? 'passphrase';
  input.type = visible ? 'text' : 'password';
  button.textContent = action;
  button.setAttribute('aria-label', `${action} ${fieldLabel}`);
  button.setAttribute('aria-pressed', String(visible));
}

export function bindPassphraseVisibility(root: ParentNode): void {
  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-passphrase-toggle]')) {
    const inputId = button.getAttribute('aria-controls');
    const input = inputId ? root.querySelector(`#${CSS.escape(inputId)}`) : null;
    if (!(input instanceof HTMLInputElement) || input.type !== 'password') {
      throw new Error('A passphrase visibility control references an invalid password input.');
    }

    setVisibility(input, button, false);
    button.addEventListener('click', () => {
      setVisibility(input, button, input.type === 'password');
      input.focus();
    });
    input.form?.addEventListener('reset', () => setVisibility(input, button, false));
    const dialog = input.closest('dialog');
    const clearDialogPassphrase = (): void => {
      input.value = '';
      setVisibility(input, button, false);
    };
    dialog?.addEventListener('cancel', clearDialogPassphrase);
    dialog?.addEventListener('close', clearDialogPassphrase);
  }
}
