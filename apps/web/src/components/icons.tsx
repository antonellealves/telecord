interface IconProps {
  className?: string;
  title?: string;
}

function Icon({ className, title, children }: IconProps & { children: JSX.Element }): JSX.Element {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title === undefined ? 'presentation' : 'img'}
      aria-hidden={title === undefined}
    >
      {title === undefined ? null : <title>{title}</title>}
      {children}
    </svg>
  );
}

export function MicIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <g>
        <rect x="9" y="2" width="6" height="11" rx="3" />
        <path d="M5 11a7 7 0 0 0 14 0M12 18v4" />
      </g>
    </Icon>
  );
}

export function MicOffIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <g>
        <path d="M15 5a3 3 0 0 0-6 0v3m0 3.5a3 3 0 0 0 5.1 1.6" />
        <path d="M5 11a7 7 0 0 0 10.5 6M19 11v.5M12 18v4" />
        <path d="M3 3l18 18" />
      </g>
    </Icon>
  );
}

export function ScreenIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <g>
        <rect x="2.5" y="4" width="19" height="12.5" rx="2" />
        <path d="M8 20.5h8M12 16.5v4" />
      </g>
    </Icon>
  );
}

export function LeaveIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <g>
        <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" />
        <path d="M10 8l-4 4 4 4M6 12h10" />
      </g>
    </Icon>
  );
}
