import { FileIcon, SpinnerIcon } from './icons';

interface DiffButtonProps {
  onClick: () => void;
  small?: boolean;
  loading?: boolean;
  disabled?: boolean;
  className?: string;
}

export const DiffButton = ({
  onClick,
  small,
  loading,
  disabled,
  className = '',
}: DiffButtonProps) => {
  const iconSize = small ? 10 : 14;
  const isDisabled = loading || disabled;
  return (
    <button
      onClick={onClick}
      disabled={isDisabled}
      className={`flex items-center gap-1 rounded-md border border-text-secondary/30 text-text-secondary hover:bg-bg-card transition-colors disabled:opacity-60 disabled:hover:bg-transparent ${
        loading ? 'disabled:cursor-wait' : 'disabled:cursor-not-allowed'
      } ${small ? 'px-1.5 py-0.5 text-[0.5rem]' : 'px-3 py-1 text-xs gap-1.5'} ${className}`}
    >
      {loading ? <SpinnerIcon size={iconSize} /> : <FileIcon size={iconSize} />}
      {loading ? 'Opening…' : 'Diff'}
    </button>
  );
};
