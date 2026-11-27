/* global require */
/* eslint-disable @typescript-eslint/no-require-imports -- Проверяем упаковку Windows-установщика обычным чтением файлов. */
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { test } = require('node:test')

const root = join(__dirname, '..')
const read = (...parts) => readFileSync(join(root, ...parts), 'utf8')

const installerScript = read('resources', 'installer.nsh')
const baseConfig = read('electron-builder.yml')
const windowsConfig = read('electron-builder.windows.yml')

test('NSIS ставит приложение в тот же каталог, что прежняя установка', () => {
  assert.match(installerScript, /!macro customInit/)
  assert.match(installerScript, /StrCpy \$INSTDIR "\$LOCALAPPDATA\\Programs\\Syntee Helper"/)
})

test('установщик убирает остатки лаунчера и его записи в реестре', () => {
  assert.match(installerScript, /!macro customInstall/)
  // Клиент и обновления лаунчера лежали в current\ и staging\.
  assert.match(installerScript, /RMDir \/r "\$INSTDIR\\current"/)
  assert.match(installerScript, /RMDir \/r "\$INSTDIR\\staging"/)
  // Своя запись лаунчера в «Установке и удаление программ» — иначе в списке
  // приложений остались бы две строки.
  assert.match(installerScript, /DeleteRegKey HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\SynteeHelper"/)
})

test('автозапуск лаунчера переводится на новый exe, а не удаляется', () => {
  // Прежний путь — current\Syntee Helper.exe; после установки его нет.
  assert.match(installerScript, /StrCmp \$2 '"\$INSTDIR\\current\\\$\{APP_EXECUTABLE_FILENAME\}"' 0 syntee_autostart_unquoted/)
  assert.match(installerScript, /WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Run" "\$1" '"\$INSTDIR\\\$\{APP_EXECUTABLE_FILENAME\}"'/)
})

test('ярлыки переписываются на новый exe после удаления current\\', () => {
  // При повторной установке штатный addDesktopLink видит KeepShortcuts=true
  // и одинаковые old/new пути — и не трогает ярлык. Без своей перезаписи
  // ярлык остался бы битым: он указывал бы на удалённый current\.
  assert.match(installerScript, /!macro syntee_repointShortcuts/)
  assert.match(installerScript, /CreateShortCut "\$newDesktopLink" "\$INSTDIR\\\$\{APP_EXECUTABLE_FILENAME\}"/)
  assert.match(installerScript, /CreateShortCut "\$newStartMenuLink" "\$INSTDIR\\\$\{APP_EXECUTABLE_FILENAME\}"/)
  // Перезапись идёт после удаления current\.
  const cleanupAt = installerScript.indexOf('!insertmacro syntee_removeLegacyLauncherFiles')
  const repointAt = installerScript.indexOf('!insertmacro syntee_repointShortcuts')
  assert.ok(cleanupAt > 0 && repointAt > cleanupAt, 'ярлыки переписываются после зачистки лаунчера')
})

test('запущенный sidecar гасится перед удалением лишней установки', () => {
  // syntee-sidecar.exe — отдельный процесс с другим именем, CHECK_APP_RUNNING
  // его не трогает. С запущенным sidecar каталог не удалится.
  assert.match(installerScript, /taskkill \/f \/im syntee-sidecar\.exe/)
})

test('nsExec в .onInit снимает код возврата со стека', () => {
  // nsExec::Exec оставляет результат на стеке; в .onInit это мусор.
  assert.match(installerScript, /nsExec::Exec 'taskkill \/f \/im syntee-launcher\.exe'\s*\n\s*Pop \$0/)
})

test('установщик не трогает данные пользователя и собственный каталог', () => {
  // Данные приложения лежат в %APPDATA%\SynteeHelper — их удалять нельзя.
  assert.doesNotMatch(installerScript, /APPDATA\\SynteeHelper/)
  assert.doesNotMatch(installerScript, /delete-app-data/i)
  // Свой каталог не должен попасть под зачистку «лишней» установки.
  assert.match(installerScript, /StrCmp \$INSTDIR "\$LOCALAPPDATA\\Programs\\syntee-helper" syntee_skip_stray_install/)
})

test('electron-builder находит installer.nsh и не кладёт его в сборку', () => {
  // buildResources: resources → packager.getResource(include, 'installer.nsh').
  assert.match(baseConfig, /buildResources: resources/)
  assert.match(baseConfig, /- "!installer\.nsh"/)
})

test('установщик Windows остаётся one-click и сохраняет имя ассета', () => {
  assert.match(windowsConfig, /extends: \.\/electron-builder\.yml/)
  assert.match(windowsConfig, /target: nsis/)
  assert.match(windowsConfig, /oneClick: true/)
  // Имя файла ищет releaseFeed.ts — менять нельзя.
  assert.match(windowsConfig, /artifactName: Syntee-Helper-Setup-\$\{version\}-\$\{arch\}\.\$\{ext\}/)
})
