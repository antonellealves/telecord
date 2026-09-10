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

export function SpeakerIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <g>
        <path d="M4 9.5h3.5L12 5.5v13L7.5 14.5H4z" />
        <path d="M16 9.5a4 4 0 0 1 0 5M18.5 7a7.5 7.5 0 0 1 0 10" />
      </g>
    </Icon>
  );
}

export function SlidersIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <g>
        <path d="M4 7h7M15 7h5M4 17h5M13 17h7M4 12h11M19 12h1" />
        <circle cx="13" cy="7" r="2" />
        <circle cx="11" cy="17" r="2" />
        <circle cx="17" cy="12" r="2" />
      </g>
    </Icon>
  );
}

export function ExpandIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <g>
        <path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5" />
      </g>
    </Icon>
  );
}

export function ShrinkIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <g>
        <path d="M4 9h5V4M20 9h-5V4M4 15h5v5M20 15h-5v5" />
      </g>
    </Icon>
  );
}

export function ChatIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <g>
        <path d="M20.5 12.5a7.5 7.5 0 0 1-7.5 7.5H8l-4 3v-4.4A7.5 7.5 0 0 1 13 5a7.5 7.5 0 0 1 7.5 7.5z" />
      </g>
    </Icon>
  );
}

export function SoundIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <g>
        <path d="M4 14v-4M8 18V6M12 15V9M16 19V5M20 13v-2" />
      </g>
    </Icon>
  );
}

export function CameraIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <g>
        <rect x="2.5" y="6" width="13" height="12" rx="2.5" />
        <path d="M15.5 10.5l6-3v9l-6-3z" />
      </g>
    </Icon>
  );
}

export function CameraOffIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <g>
        <path d="M15.5 10.5l6-3v9l-3.2-1.6" />
        <path d="M13 6h-2M5 6h-.5A2 2 0 0 0 2.5 8v8a2 2 0 0 0 2 2h9a2 2 0 0 0 1.7-1" />
        <path d="M3 3l18 18" />
      </g>
    </Icon>
  );
}

export function StopIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <g>
        {/* Preenchido: num alvo pequeno o quadrado só de contorno vira borrão
            e deixa de ler como "parar". */}
        <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none" />
      </g>
    </Icon>
  );
}
