import { useSettingsStore } from '../../../store/settings.store'
import Toggle from '../../ui/Toggle/Toggle'
import { SectionTitle, Group, Field } from '../SettingsPrimitives'
import { OPTIONAL_TOOL_GROUPS, PROTECTED_CORE_TOOLS, normalizeDisabledTools } from '../../../../../shared/toolSettings'

export default function ToolsSettingsTab() {
  const settings = useSettingsStore(s => s.settings)
  const set = useSettingsStore(s => s.set)
  const enabled = settings.customToolsEnabled === true
  const disabled = normalizeDisabledTools(settings.disabledTools)
  const update = (names: string[], on: boolean) => {
    const next = disabled.filter(tool => !names.includes(tool))
    void set('disabledTools', on ? next : [...next, ...names])
  }

  return <div>
    <SectionTitle description="Выберите дополнительные инструменты, доступные модели. Основные инструменты защищены.">Инструменты</SectionTitle>
    <Group id="tools-master" icon="wrench" title="Настраивать инструменты агента" right={<Toggle value={enabled} onChange={v => { void set('customToolsEnabled', v) }} />}>
      <p className="settings-card-intro">Когда настройка выключена, используется штатный набор Syntee. Ваш выбор сохраняется, но не применяется. Ограничения режима, персоны и доступа продолжают действовать.</p>
      <button type="button" className="settings-btn" onClick={() => { void set('disabledTools', []) }}>Сбросить — включить все дополнительные</button>
    </Group>
    {OPTIONAL_TOOL_GROUPS.map(group => {
      const names = group.tools.map(tool => tool.name)
      const allOn = names.every(name => !disabled.includes(name))
      const count = names.filter(name => !disabled.includes(name)).length
      return <Group key={group.label} id={`tools-${names[0]}`} icon="wrench" title={group.label} right={<Toggle value={allOn} disabled={!enabled} onChange={v => update(names, v)} />}>
        <p className="settings-card-intro">Выбрано {count} из {names.length}. Доступность также зависит от режима и разрешений.</p>
        {group.tools.map(tool => <Field key={tool.name} id={`tool-${tool.name}`} label={tool.label} description={tool.name}>
          <Toggle value={!disabled.includes(tool.name)} disabled={!enabled} onChange={v => update([tool.name], v)} />
        </Field>)}
      </Group>
    })}
    <Group id="tools-core" icon="shield" title="Основные инструменты" note="Защищены от отключения">
      <p className="settings-card-intro">Эти инструменты нельзя отключить здесь. Read-only режимы и разрешения по-прежнему ограничивают их доступность.</p>
      {PROTECTED_CORE_TOOLS.map(name => <Field key={name} label={name} description="Основной системный инструмент"><Toggle value disabled /></Field>)}
    </Group>
  </div>
}
