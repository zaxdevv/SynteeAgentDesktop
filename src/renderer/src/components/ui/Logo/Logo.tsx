import logoUrl from '../../../assets/syntee-logo.svg'

interface LogoProps {
  size?: number
  className?: string
}

/**
 * Syntee ribbon S. A CSS mask keeps the original SVG silhouette while
 * supporting both solid and gradient theme accents via --accent-bg.
 */
export default function Logo({ size = 32, className }: LogoProps) {
  return (
    <div
      className={className}
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        background: 'var(--accent-bg)',
        WebkitMaskImage: `url("${logoUrl}")`,
        maskImage: `url("${logoUrl}")`,
        WebkitMaskSize: 'contain',
        maskSize: 'contain',
        WebkitMaskPosition: 'center',
        maskPosition: 'center',
        WebkitMaskRepeat: 'no-repeat',
        maskRepeat: 'no-repeat',
        flexShrink: 0,
      }}
    />
  )
}
