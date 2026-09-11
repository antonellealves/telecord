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

export function InfoIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <g>
        <circle cx="12" cy="12" r="9" />
        {/* O pingo é um traço de comprimento quase zero: com ponta redonda ele
            desenha um ponto sem virar um segundo caminho para manter. */}
        <path d="M12 8.1v.01M12 11.4v4.6" />
      </g>
    </Icon>
  );
}

export function RefreshIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <g>
        {/* Arco aberto, não círculo fechado: é a falta do pedaço que faz a
            seta ler como "de novo" em vez de "carregando". */}
        <path d="M20 12a8 8 0 1 1-2.6-5.9" />
        <path d="M20 4v4.5h-4.5" />
      </g>
    </Icon>
  );
}

export function MoonIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <g>
        <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" />
      </g>
    </Icon>
  );
}

export function UploadIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <g>
        {/* Seta para CIMA saindo da bandeja: para baixo leria como baixar. */}
        <path d="M12 16V4" />
        <path d="M7.5 8.5 12 4l4.5 4.5" />
        <path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15" />
      </g>
    </Icon>
  );
}

export function TrashIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <g>
        <path d="M4 7h16" />
        <path d="M9.5 7V5.5A1.5 1.5 0 0 1 11 4h2a1.5 1.5 0 0 1 1.5 1.5V7" />
        <path d="M6.5 7l.8 11.1A1.5 1.5 0 0 0 8.8 19.5h6.4a1.5 1.5 0 0 0 1.5-1.4L17.5 7" />
      </g>
    </Icon>
  );
}

export function ChartIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <g>
        <path d="M4 20h16" />
        <path d="M7 20v-6" />
        <path d="M12 20V6" />
        <path d="M17 20v-9" />
      </g>
    </Icon>
  );
}

export function SearchIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <g>
        <circle cx="11" cy="11" r="6" />
        <path d="m20 20-3.6-3.6" />
      </g>
    </Icon>
  );
}

export function PlusIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <g>
        <path d="M12 5v14" />
        <path d="M5 12h14" />
      </g>
    </Icon>
  );
}

export function PencilIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <g>
        <path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17v3z" />
        <path d="M14.5 6.5l3 3" />
      </g>
    </Icon>
  );
}

/**
 * Marca do Google. Fora do `Icon` porque é a única com cor própria: as quatro
 * cores são parte da identidade e não podem herdar `currentColor` como as
 * outras.
 */
export function GoogleMark({ className }: { className?: string }): JSX.Element {
  return (
    <svg className={className} viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.5h6.5a5.6 5.6 0 0 1-2.4 3.6v3h3.9c2.3-2.1 3.5-5.2 3.5-8.8z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.2 0 5.9-1.1 7.9-2.9l-3.9-3c-1.1.7-2.4 1.2-4 1.2-3.1 0-5.7-2.1-6.6-4.9H1.4v3.1A12 12 0 0 0 12 24z"
      />
      <path fill="#FBBC05" d="M5.4 14.4a7.2 7.2 0 0 1 0-4.6V6.7H1.4a12 12 0 0 0 0 10.7l4-3z" />
      <path
        fill="#EA4335"
        d="M12 4.8c1.8 0 3.4.6 4.6 1.8l3.4-3.4C17.9 1.2 15.2 0 12 0A12 12 0 0 0 1.4 6.7l4 3.1C6.3 6.9 8.9 4.8 12 4.8z"
      />
    </svg>
  );
}

export function EyeIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <g>
        <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z" />
        <circle cx="12" cy="12" r="3" />
      </g>
    </Icon>
  );
}

/** Olho cortado: "parar de assistir". O traço diagonal é o mesmo do mudo. */
export function EyeOffIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <g>
        <path d="M10.6 6.2A9.9 9.9 0 0 1 12 6c6.5 0 10 6 10 6a17 17 0 0 1-3.1 3.8M6.3 6.5C3.6 8.2 2 12 2 12s3.5 6 10 6a9.9 9.9 0 0 0 4-.8" />
        <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
        <path d="M3 3l18 18" />
      </g>
    </Icon>
  );
}

/** Duas pessoas: a lista de participantes. */
export function PeopleIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <g>
        <path d="M16 19v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 17.5V19" />
        <circle cx="10" cy="7.5" r="3" />
        <path d="M20 19v-1.5a3.5 3.5 0 0 0-2.6-3.4M15.5 4.7a3 3 0 0 1 0 5.6" />
      </g>
    </Icon>
  );
}
