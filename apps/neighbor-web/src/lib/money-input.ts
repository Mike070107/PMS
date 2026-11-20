import type { WheelEvent } from 'react';

export const moneyInputProps = {
  'data-money-input': '',
  onWheel(event: WheelEvent<HTMLInputElement>) {
    if (event.currentTarget === document.activeElement) event.currentTarget.blur();
  },
};
