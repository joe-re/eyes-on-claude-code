interface IconProps {
  size?: number;
  className?: string;
}

export const FileIcon = ({ size = 14, className = '' }: IconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    className={className}
  >
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14,2 14,8 20,8" />
  </svg>
);

export const SpinnerIcon = ({ size = 14, className = '' }: IconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    className={`animate-spin ${className}`}
  >
    <path d="M12 2a10 10 0 0 1 10 10" />
  </svg>
);

export const ChevronDownIcon = ({ size = 12, className = '' }: IconProps) => (
  <svg width={size} height={size * (8 / 12)} viewBox="0 0 12 8" fill="none" className={className}>
    <path
      d="M1 1.5L6 6.5L11 1.5"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);
