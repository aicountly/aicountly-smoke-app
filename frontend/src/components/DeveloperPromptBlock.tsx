import { CopyButton } from '@/components/CopyButton';

type DeveloperPromptBlockProps = {
  prompt: string;
  summaryLabel?: string;
  /** Open by default where the prompt is the point of the view, not an aside. */
  defaultOpen?: boolean;
};

export function DeveloperPromptBlock({
  prompt,
  summaryLabel = 'Technical details',
  defaultOpen = false,
}: DeveloperPromptBlockProps) {
  if (!prompt) return null;
  return (
    <div className="mt-2">
      <details open={defaultOpen}>
        <summary className="cursor-pointer text-xs text-ink-500 hover:text-ink-800 select-none">
          {summaryLabel}
        </summary>
        <div className="mt-1 flex items-center gap-2 mb-1">
          <span className="text-xs font-medium text-ink-500">Developer prompt</span>
          <CopyButton text={prompt} label="Copy for Cursor" title="Copy this prompt for Cursor" />
        </div>
        <pre className="max-h-48 overflow-auto rounded bg-ink-50 border border-ink-100 p-2 text-xs font-mono text-ink-800 whitespace-pre-wrap break-words">
          {prompt}
        </pre>
      </details>
    </div>
  );
}
