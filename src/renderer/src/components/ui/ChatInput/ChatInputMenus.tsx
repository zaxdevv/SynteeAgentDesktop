import SlashMenu from '../SlashMenu/SlashMenu'
import MentionMenu from '../MentionMenu/MentionMenu'
import CommandArgMenu from '../CommandArgMenu/CommandArgMenu'
import { PluginAutoMenu } from './PluginAutoMenu'
import type { SlashCommand } from '../../../../../shared/slashCommands'
import type { MentionItem } from '../../../../../shared/types'
import type { PluginAutoResult } from '../../../utils/pluginExtApi'

interface ChatInputMenusProps {
  slashCmds: SlashCommand[]
  slashIdx: number
  mentionItems: MentionItem[]
  mentionIdx: number
  argPickerCmd: SlashCommand | null
  argPickerLevel: number
  argPickerChoices: string[]
  argPickerIdx: number
  boxRef: React.RefObject<HTMLElement | null>
  onSelectCommand: (cmd: SlashCommand) => void
  onCloseSlash: () => void
  onSelectMention: (item: MentionItem) => void
  onCloseMention: () => void
  onSelectArgChoice: (choice: string) => void
  onCloseArgPicker: () => void
  // Autocomplete-провайдер плагина (registerAutocomplete).
  pluginAuto: PluginAutoResult | null
  pluginAutoIdx: number
  onSelectPluginAuto: (idx: number) => void
  onClosePluginAuto: () => void
}

/**
 * Выпадающие меню автокомплита инпута: слеш-команды (/), @mention-файлы,
 * пикер аргументов команды (enum-выбор) и подсказки autocomplete-провайдера
 * плагина. Все якорятся к инпут-боксу (boxRef).
 */
export function ChatInputMenus({
  slashCmds,
  slashIdx,
  mentionItems,
  mentionIdx,
  argPickerCmd,
  argPickerLevel,
  argPickerChoices,
  argPickerIdx,
  boxRef,
  onSelectCommand,
  onCloseSlash,
  onSelectMention,
  onCloseMention,
  onSelectArgChoice,
  onCloseArgPicker,
  pluginAuto,
  pluginAutoIdx,
  onSelectPluginAuto,
}: ChatInputMenusProps) {
  const anchor = boxRef as React.RefObject<HTMLElement>
  return (
    <>
      {/* Слеш-меню */}
      <SlashMenu
        commands={slashCmds}
        selectedIndex={slashIdx}
        anchorRef={anchor}
        onSelect={onSelectCommand}
        onClose={onCloseSlash}
      />

      {/* @mention-меню */}
      <MentionMenu
        items={mentionItems}
        selectedIndex={mentionIdx}
        anchorRef={anchor}
        onSelect={onSelectMention}
        onClose={onCloseMention}
      />

      {/* Пикер аргументов команды (многоуровневый enum-пикер) */}
      <CommandArgMenu
        cmd={argPickerCmd}
        level={argPickerLevel}
        choices={argPickerChoices}
        selectedIndex={argPickerIdx}
        anchorRef={anchor}
        onSelect={onSelectArgChoice}
        onClose={onCloseArgPicker}
      />

      {/* Подсказки autocomplete-провайдера плагина */}
      <PluginAutoMenu
        auto={pluginAuto}
        selectedIndex={pluginAutoIdx}
        anchorRef={anchor}
        onSelect={onSelectPluginAuto}
      />
    </>
  )
}
