// Evaluate controls at each Tab: asynchronous forms may enable or replace them.
export function dialogControls(dialog: HTMLElement): HTMLElement[] {
  return [...dialog.querySelectorAll<HTMLElement>('button,input,select,textarea,a[href],[tabindex],[contenteditable="true"]')]
    .filter(control => control.tabIndex >= 0 && !control.matches(':disabled')
      && !control.closest('[hidden],[inert],[aria-hidden="true"]')
      && getComputedStyle(control).display !== 'none' && getComputedStyle(control).visibility !== 'hidden');
}
