import SlashMenu from '../SlashMenu/SlashMenu'
import MentionMenu from '../MentionMenu/MentionMenu'
import CommandArgMenu from '../CommandArgMenu/CommandArgMenu'
import type { SlashCommand } from '../../../../../shared/slashCommands'
import type { MentionItem } from '../../../../../shared/types'

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
}

/**
 * Выпадающие меню автокомплита инпута: слеш-команды (/), @mention-файлы
 * и многоуровневый пикер аргументов команды (enum-выбор). Все якорятся к
 * инпут-боксу (boxRef).
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
    </>
  )
}
