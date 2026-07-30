import { useEffect, useRef, useState } from 'react';
import { copyText } from '@/lib/clipboard';

type CopyButtonProps = {
  text: string;
  label?: string;
  copiedLabel?: string;
  failedLabel?: string;
  className?: string;
  title?: string;
  disabled?: boolean;
};

/**
 * Copies text and says so. Owns its own feedback state, so a page can put one
 * beside every prompt without threading a copied-key through the tree.
 */
export function CopyButton({
  text,
  label = 'Copy',
  copiedLabel = 'Copied',
  failedLabel = 'Copy failed',
  className = 'btn-secondary text-xs py-0.5 px-2',
  title,
  disabled,
}: CopyButtonProps) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const resetRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (resetRef.current) clearTimeout(resetRef.current);
  }, []);

  async function handleClick() {
    const ok = await copyText(text);
    setState(ok ? 'copied' : 'failed');
    if (resetRef.current) clearTimeout(resetRef.current);
    resetRef.current = setTimeout(() => setState('idle'), 2000);
  }

  return (
    <button
      type="button"
      className={className}
      title={title}
      disabled={disabled || text.trim() === ''}
      onClick={() => void handleClick()}
    >
      {state === 'copied' ? copiedLabel : state === 'failed' ? failedLabel : label}
    </button>
  );
}
