// ── ask_user: тул уточняющих вопросов пользователю ──────────────────────
// Спецификация одного вопроса, который AI задаёт пользователю через UI-панель.

export interface QuestionOption {
  /** Идентификатор опции (для маппинга ответа обратно к модели). */
  value: string
  /** Отображаемый текст опции. */
  label: string
  /** Необязательное описание опции (пояснение). */
  description?: string
}

/** Тип вопроса — определяет UI-рендер в QuestionPanel. */
export type QuestionType = 'text' | 'choice' | 'yesno'

/** Условие показа вопроса (conditional). Вопрос скрыт пока условие не выполнено. */
export interface QuestionCondition {
  /** ID вопроса, ответ которого проверяется. */
  questionId: string
  /** Значение (или массив значений), при котором этот вопрос показывается. */
  equals: string | string[]
}

export interface QuestionSpec {
  /** ID вопроса — модель может указать свой; иначе генерируется. */
  id?: string
  /** Текст вопроса. */
  question: string
  /** Короткий заголовок (необязательно). */
  header?: string
  /**
   * Тип вопроса — определяет UI-рендер.
   * - text (default) — свободный текстовый ответ
   * - choice — выбор из options (с radio/checkbox)
   * - yesno — две большие кнопки Да/Нет (быстрое подтверждение)
   * Если не указан, авто-detect: есть options → choice, иначе text.
   */
  type?: QuestionType
  /** Готовые варианты ответа (для type=choice). */
  options?: QuestionOption[]
  /** Разрешить множественный выбор (только для type=choice). */
  multiple?: boolean
  /** Разрешить свой ответ (default true). Для yesno — игнорируется. */
  allowCustom?: boolean
  /** Вопрос обязательный (нельзя пропустить). */
  required?: boolean
  /** Кастомный placeholder для текстового поля. */
  placeholder?: string
  /** Пояснение под вопросом (раскрывающийся блок). Для контекста. */
  helpText?: string
  /** Многострочное текстовое поле (5+ строк вместо 2). Для описательных ответов. */
  multiline?: boolean
  /** Кастомный текст кнопки пропуска (default 'Пропустить'). */
  skipLabel?: string
  /** Условие показа — вопрос скрыт пока ответ на questionId не равен equals. */
  showIf?: QuestionCondition
}

/** Ответ пользователя на один вопрос. */
export interface QuestionAnswer {
  /** ID вопроса из QuestionSpec (или сгенерированный). */
  id: string
  /** Выбранные значения опций (для choice/multiple). */
  values?: string[]
  /** Свободный текстовый ответ (text/choice+allowCustom). */
  text?: string
  /** Да/Нет (для yesno). */
  value?: boolean
}
