import { forwardRef, useImperativeHandle, useRef } from 'react';
import { BankOutlined, MoreOutlined } from '@ant-design/icons';
import { PaymentMethodIcon } from './PaymentMethodIcon';
import './MeterPaymentMethods.css';

const OPTIONS = [
  { value: 'wechat', label: '微信' }, { value: 'alipay', label: '支付宝' },
  { value: 'cash', label: '现金' }, { value: 'bank', label: '银行转账' }, { value: 'other', label: '其他' },
] as const;
export default forwardRef(function MeterPaymentMethods({ value, onChange, disabled, ...aria }: {
  value?: string; onChange?: (value: string) => void; disabled?: boolean;
  id?: string; 'aria-invalid'?: boolean; 'aria-describedby'?: string;
}, ref) {
  const group = useRef<HTMLDivElement>(null);
  useImperativeHandle(ref, () => ({ focus: () => group.current?.querySelector('button')?.focus() }));
  return <div {...aria} ref={group} role="group" aria-label="收款方式" className="meter-payment-methods">
    {OPTIONS.map((item) => <button type="button" key={item.value} disabled={disabled}
      className={`meter-payment-method ${item.value}`} aria-pressed={value === item.value}
      onClick={() => onChange?.(item.value)}>
      {item.value === 'bank' ? <BankOutlined /> : item.value === 'other' ? <MoreOutlined /> : <PaymentMethodIcon type={item.value} />}
      <span>{item.label}</span>
    </button>)}
  </div>;
});
