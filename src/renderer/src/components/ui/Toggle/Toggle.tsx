import { playClickSound } from '../../../utils/sounds'

export interface ToggleProps {
  value: boolean
  onChange: (v: boolean) => void
  /** Если true — toggle нельзя переключить (полу-прозрачный, без cursor). */
  disabled?: boolean
  /** ARIA-метка для скринридеров. */
  'aria-label'?: string
}

// Единый toggle-switch для всех настроек. Раньше копия этой логики
// жила в SettingsPage / ContextSettingsTab —
// теперь один источник правды. CSS-классы (.settings-toggle,
// .settings-toggle-thumb) определены в SettingsPage.css глобально.
export default function Toggle({ value, onChange, disabled, ...rest }: ToggleProps) {
  return (
    <button
      type="button"
      className={`settings-toggle ${value ? 'settings-toggle--on' : ''}${disabled ? ' settings-toggle--disabled' : ''}`}
      onClick={() => { if (!disabled) { playClickSound(); onChange(!value) } }}
      disabled={disabled}
      aria-pressed={value}
      {...rest}
    >
      <span className="settings-toggle-thumb" aria-hidden="true" />
    </button>
  )
}
