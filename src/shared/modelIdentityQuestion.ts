const russianQuestion = /^(?:(?:какая|какой|что за) (?:(?:ты|у тебя) (?:сейчас )?модель(?: ии)?|модель (?:у тебя|ты))(?: сейчас)?|ты (?:какая|какой|что за) модель(?: сейчас)?|на какой модели ты (?:работаешь|запущен(?:а)?))$/
const englishQuestion = /^(?:(?:what|which) model (?:are you(?: using| running on)?|do you use)|what(?: is|'s) your model(?: name)?|tell me your model)$/

/** Match only a standalone request about this chat's model. */
export function modelIdentityQuestion(text: string): 'ru' | 'en' | undefined {
  if (text.length > 160) return undefined
  const normalized = text.toLowerCase().trim().replace(/[,?!.…]+/g, ' ').replace(/\s+/g, ' ').trim()
  const russian = normalized.replace(/^(?:скажи|подскажи|пожалуйста|кратко) /, '').replace(/ (?:кратко|коротко|пожалуйста)$/, '')
  if (russianQuestion.test(russian)) return 'ru'
  const english = normalized.replace(/^(?:please|quickly) /, '').replace(/ (?:please|briefly)$/, '')
  return englishQuestion.test(english) ? 'en' : undefined
}
