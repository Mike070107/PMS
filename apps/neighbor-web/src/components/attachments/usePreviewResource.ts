import { useEffect, useState } from 'react';
import { previewError } from './types';

export function usePreviewResource<T>(load: (signal: AbortSignal, own: (blob: Blob) => string) => Promise<T>) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{load:typeof load; value?:T; error?:string}>();
  useEffect(() => {
    const controller = new AbortController();
    const urls: string[] = [];
    const release = () => urls.splice(0).forEach(url => URL.revokeObjectURL(url));
    const timer = setTimeout(() => { controller.abort(); release(); setState({load,error:'附件加载超时，请重试'}); }, 45000);
    setState({load});
    load(controller.signal, blob => {
      controller.signal.throwIfAborted();
      const url = URL.createObjectURL(blob); urls.push(url); return url;
    }).then(value => { if (!controller.signal.aborted) setState({load,value}); })
      .catch(e => { if (!controller.signal.aborted) { release(); setState({load,error:previewError(e)}); } })
      .finally(() => clearTimeout(timer));
    return () => { clearTimeout(timer); controller.abort(); release(); };
  }, [load,attempt]);
  return { ...(state?.load === load ? state : {}), retry: () => setAttempt(n=>n+1) };
}
