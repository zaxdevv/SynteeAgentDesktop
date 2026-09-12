/**
 * ExtListToolbar — общий тулбар списка расширений (Skills / MCP / Plugins):
 * поле поиска + chip-фильтры со счётчиками.
 *
 * Используется во всех трёх вкладках ExtensionsPopover, чтобы поиск и
 * фильтры выглядели и вели себя одинаково.
 *
 * Особенности:
 *   - ESC в поле поиска: если текст есть — очищает поиск (не закрывает
 *     модалку); если поле пустое — событие проходит дальше (модалка закроется).
 *   - Крестик очистки появляется только при непустом запросе.
 */
import AppIcon from '../AppIcon/AppIcon'

/** Один chip-фильтр: значение + подпись + счётчик. */
export interface ExtFilterChip<T extends string = string> {
  value: T
  label: string
  count: number
}

interface ExtListToolbarProps<T extends string> {
  search: string
  onSearch: (v: string) => void
  placeholder?: string
  /** Список chip-фильтров; пустой/undefined — строка фильтров не рендерится. */
  filters?: ExtFilterChip<T>[]
  activeFilter?: T
  onFilter?: (v: T) => void
}

export default function ExtListToolbar<T extends string = string>({
  search,
  onSearch,
  placeholder,
  filters,
  activeFilter,
  onFilter,
}: ExtListToolbarProps<T>): JSX.Element {
  return (
    <div className="ext-list-toolbar">
      <div className="ext-installed-search">
        <div className="ext-installed-search-wrap">
          <span className="ext-installed-search-icon">
            <AppIcon name="search" size="xs" />
          </span>
          <input
            value={search}
            onChange={e => onSearch(e.target.value)}
            onKeyDown={e => {
              // ESC с непустым запросом — очищаем поиск, модалку не закрываем.
              if (e.key === 'Escape' && search !== '') {
                e.stopPropagation()
                onSearch('')
              }
            }}
            placeholder={placeholder ?? 'Поиск…'}
            spellCheck={false}
          />
          {search !== '' && (
            <button
              className="ext-installed-search-clear"
              onClick={() => onSearch('')}
              title="Очистить"
              aria-label="Очистить поиск"
            >
              <AppIcon name="x" size="xs" />
            </button>
          )}
        </div>
      </div>
      {filters && filters.length > 0 && (
        <div className="ext-installed-filters">
          {filters.map(f => (
            <button
              key={f.value}
              className={`ext-installed-filter${activeFilter === f.value ? ' ext-installed-filter--active' : ''}`}
              onClick={() => onFilter?.(f.value)}
            >
              {f.label} ({f.count})
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
