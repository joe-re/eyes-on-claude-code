import { FileIcon, SpinnerIcon } from './icons';

export type DiffButtonState = 'idle' | 'loading' | 'blocked';

interface DiffButtonProps {
  onClick: () => void;
  small?: boolean;
  state?: DiffButtonState;
  className?: string;
}

export const DiffButton = ({
  onClick,
  small,
  state = 'idle',
  className = '',
}: DiffButtonProps) => {
  const iconSize = small ? 10 : 14;
  const loading = state === 'loading';
  const cursor = loading ? 'disabled:cursor-wait' : 'disabled:cursor-not-allowed';
  return (
    <button
      onClick={onClick}
      disabled={state !== 'idle'}
      className={`flex items-center gap-1 rounded-md border border-text-secondary/30 text-text-secondary hover:bg-bg-card transition-colors disabled:opacity-60 disabled:hover:bg-transparent ${cursor} ${
        small ? 'px-1.5 py-0.5 text-[0.5rem]' : 'px-3 py-1 text-xs gap-1.5'
      } ${className}`}
    >
      {loading ? <SpinnerIcon size={iconSize} /> : <FileIcon size={iconSize} />}
      {loading ? 'Opening…' : 'Diff'}
    </button>
  );
};
