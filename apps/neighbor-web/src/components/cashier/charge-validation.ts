import { createContext } from 'react';

export const ChargeAttempted = createContext(false);

export function focusChargeIssue(root: HTMLElement | null) {
    const field = root?.querySelector<HTMLElement>('[aria-invalid="true"]');
    const target = field ?? root?.querySelector<HTMLElement>('[data-charge-next]');
    if (!target) return;
    for (let el: HTMLElement | null = target; el; el = el.parentElement) {
      if (el instanceof HTMLDetailsElement) el.open = true;
    }
    target.scrollIntoView({block:'center'});
    (target.matches('fieldset,div') ? target.querySelector<HTMLElement>('input,button,select') ?? target : target).focus();
}
