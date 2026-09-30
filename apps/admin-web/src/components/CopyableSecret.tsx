import { CheckOutlined, CopyOutlined } from '@ant-design/icons';
import { Button } from 'antd';
import { useEffect, useId, useRef, useState } from 'react';
import './CopyableSecret.css';

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // HTTP 内网页或剪贴板权限受限时，退回到浏览器的兼容复制方式。
    }
  }

  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.readOnly = true;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  if (!copied) throw new Error('剪贴板不可用');
}

export default function CopyableSecret({ label, value }: { label: string; value: string }) {
  const labelId = useId();
  const resetTimer = useRef<number | null>(null);
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle');

  useEffect(() => () => {
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
  }, []);

  const handleCopy = async () => {
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    try {
      await copyText(value);
      setStatus('copied');
    } catch {
      setStatus('failed');
    }
    resetTimer.current = window.setTimeout(() => setStatus('idle'), 3000);
  };

  return (
    <div className="copyable-secret">
      <span id={labelId} className="copyable-secret-label">{label}</span>
      <div className="copyable-secret-row">
        <code className="copyable-secret-value" tabIndex={0} aria-labelledby={labelId}>{value}</code>
        <Button
          className="copyable-secret-button"
          icon={status === 'copied' ? <CheckOutlined /> : <CopyOutlined />}
          onClick={() => void handleCopy()}
          aria-label={`复制完整${label}`}
        >
          {status === 'copied' ? '已复制' : '复制'}
        </Button>
      </div>
      <span className={`copyable-secret-status${status === 'failed' ? ' is-error' : ''}`} aria-live="polite">
        {status === 'failed' ? '复制失败，请在密钥上全选后手动复制。' : status === 'copied' ? '完整密钥已复制到剪贴板。' : ''}
      </span>
    </div>
  );
}
