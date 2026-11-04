import type { CSSProperties, ReactNode } from 'react';

export const wideDropdownProps = {
  popupMatchSelectWidth: false,
  dropdownStyle: { minWidth: 520, maxWidth: 840 } satisfies CSSProperties,
};

export const searchableWideSelectProps = {
  ...wideDropdownProps,
  showSearch: true,
  optionFilterProp: 'label' as const,
};

export const searchableExtraWideSelectProps = {
  ...searchableWideSelectProps,
  dropdownStyle: { minWidth: 680, maxWidth: 1040 } satisfies CSSProperties,
};

export function withOptionTitles<T extends { label?: ReactNode; title?: string }>(options: T[]): T[] {
  return options.map((option) => ({
    ...option,
    title: option.title || (typeof option.label === 'string' ? option.label : undefined),
  }));
}
