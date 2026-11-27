# Кастомизация NSIS-установщика Syntee Helper.
# electron-builder подхватывает файл сам: buildResources = resources,
# а в electron-builder.windows.yml задан target nsis (one-click).
#
# Зачем это нужно.
# Имя каталога установки electron-builder берёт из поля `name` в package.json
# («syntee-helper»), а не из productName. Из-за этого 1.1.5 встала в
# %LOCALAPPDATA%\Programs\syntee-helper — второй установкой рядом с прежней
# %LOCALAPPDATA%\Programs\Syntee Helper (там жил лаунчер 1.1.4). Ярлык
# «Syntee Helper» при этом указывал то на одну копию, то на другую: лаунчер
# при каждом старте переписывал ярлык обратно на свой current\.
#
# Теперь установка идёт в тот же каталог, что и раньше, а остатки лаунчера
# вычищаются: остаётся одна установка, один ярлык и одна запись в списке
# приложений. Данные пользователя (%APPDATA%\SynteeHelper) не затрагиваются.

# Файлы прежней (лаунчерной) установки: клиент лежал в current\,
# скачанные обновления — в staging\.
!macro syntee_removeLegacyLauncherFiles
  RMDir /r "$INSTDIR\current"
  RMDir /r "$INSTDIR\staging"
  Delete "$INSTDIR\syntee-launcher.exe"
  Delete "$INSTDIR\launcher.json"
  Delete "$INSTDIR\launcher.json.bak"
  Delete "$INSTDIR\install-options.json"
  Delete "$INSTDIR\.setup_done"
  Delete "$INSTDIR\syntee-launcher.log"
!macroend

# Автозапуск лаунчера указывал на current\Syntee Helper.exe. Переносим его на
# новый exe, чтобы настройка «Запуск при входе в систему» не слетала и
# лаунчер не воскресал после перезагрузки.
!macro syntee_repointAutostart
  StrCpy $0 0
  syntee_autostart_loop:
    EnumRegValue $1 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" $0
    StrCmp $1 "" syntee_autostart_done
    IntOp $0 $0 + 1
    ReadRegStr $2 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "$1"
    StrCmp $2 '"$INSTDIR\current\${APP_EXECUTABLE_FILENAME}"' 0 syntee_autostart_unquoted
      WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "$1" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
      Goto syntee_autostart_loop
    syntee_autostart_unquoted:
    StrCmp $2 "$INSTDIR\current\${APP_EXECUTABLE_FILENAME}" 0 syntee_autostart_loop
      WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "$1" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
      Goto syntee_autostart_loop
  syntee_autostart_done:
!macroend

!macro customInit
  # Тот же каталог, что у прежней установки: ярлыки, автозапуск и запись
  # в «Установке и удаление программ» остаются в единственном экземпляре.
  StrCpy $INSTDIR "$LOCALAPPDATA\Programs\Syntee Helper"

  # Лаунчер при старте «починяет» ярлыки на свой current\Syntee Helper.exe.
  # Гасим его до установки, иначе после неё ярлык снова смотрел бы на 1.1.4.
  # nsExec кладёт код возврата на стек — снимаем его, чтобы не оставлять
  # мусор в стеке .onInit.
  nsExec::Exec 'taskkill /f /im syntee-launcher.exe'
  Pop $0
!macroend

# Ярлыки прежней установки указывают на current\Syntee Helper.exe. При первой
# установке штатный addDesktopLink их пересоздаёт (keepShortcuts = false), но
# при повторной установке он видит KeepShortcuts = true и одинаковые old/new
# пути — и не трогает ярлык вообще. Переписываем сами, чтобы ярлык никогда не
# остался указывать на удалённый current\.
!macro syntee_repointShortcuts
  IfFileExists "$newDesktopLink" 0 syntee_no_desktop_link
    CreateShortCut "$newDesktopLink" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 "" "" "${APP_DESCRIPTION}"
  syntee_no_desktop_link:
  IfFileExists "$newStartMenuLink" 0 syntee_no_menu_link
    CreateShortCut "$newStartMenuLink" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 "" "" "${APP_DESCRIPTION}"
  syntee_no_menu_link:
!macroend

!macro customInstall
  # Файлы лаунчера есть только у прежней установки — у чистой её нет.
  IfFileExists "$INSTDIR\launcher.json" 0 syntee_no_legacy_launcher
  !insertmacro syntee_removeLegacyLauncherFiles
  !insertmacro syntee_repointAutostart
  !insertmacro syntee_repointShortcuts
  syntee_no_legacy_launcher:

  # Своя запись лаунчера в «Установке и удаление программ». Установщик
  # регистрируется под ключом по appId, поэтому эта запись осталась бы
  # висеть второй строкой.
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SynteeHelper"

  # Установка 1.1.5, сделанная до этого исправления, лежит рядом в каталоге
  # со строчными буквами — убираем, чтобы не осталось двух копий приложения.
  # Sidecar — отдельный процесс со своим именем, CHECK_APP_RUNNING его не
  # трогает; с запущенным syntee-sidecar.exe каталог не удалится.
  StrCmp $INSTDIR "$LOCALAPPDATA\Programs\syntee-helper" syntee_skip_stray_install
  nsExec::Exec 'taskkill /f /im syntee-sidecar.exe'
  Pop $0
  Sleep 300
  RMDir /r "$LOCALAPPDATA\Programs\syntee-helper"
  syntee_skip_stray_install:
!macroend
