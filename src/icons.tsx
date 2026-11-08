import type { ReactNode } from 'react'

type IconProps = { size?: number; className?: string }

function Svg({ size = 16, className, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

export function IconEye({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
    </Svg>
  )
}

export function IconEyeOff({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M3 3l18 18" />
      <path d="M10.6 10.6a2.5 2.5 0 0 0 3.4 3.4" />
      <path d="M9.9 5.2A11 11 0 0 1 12 5c6.5 0 10 7 10 7a18.5 18.5 0 0 1-2.2 3.1" />
      <path d="M6.1 6.1A18.3 18.3 0 0 0 2 12s3.5 7 10 7a10.5 10.5 0 0 0 4.1-.8" />
    </Svg>
  )
}

export function IconHeart({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M20.8 5.6a5 5 0 0 0-7.1 0L12 7.3l-1.7-1.7a5 5 0 0 0-7.1 7.1L12 21.4l8.8-8.7a5 5 0 0 0 0-7.1Z" />
    </Svg>
  )
}

export function IconClock({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </Svg>
  )
}

export function IconChat({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M21 12a8 8 0 0 1-8 8H7l-4 3V12a8 8 0 1 1 18 0Z" />
    </Svg>
  )
}

export function IconArchive({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <rect x="3" y="4" width="18" height="4" rx="1" />
      <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" />
      <path d="M10 12h4" />
    </Svg>
  )
}

export function IconTrash({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M3 6h18" />
      <path d="M8 6V4h8v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
    </Svg>
  )
}

export function IconPanel({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M4 6h16M4 12h16M4 18h16" />
    </Svg>
  )
}

export function IconPanelClose({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M4 6h10M4 12h16M4 18h10" />
      <path d="M15 9l3 3-3 3" />
    </Svg>
  )
}

export function IconPlay({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M8 5v14l11-7Z" fill="currentColor" stroke="none" />
    </Svg>
  )
}
