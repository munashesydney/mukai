; Extend electron-builder's assisted installer; keep its install/uninstall logic.
!macro customInstallMode
  ; Install for the current user, without an administrator prompt.
  StrCpy $isForceCurrentInstall "1"
!macroend

!macro customUnInstall
  ; Desktop shortcuts are optional and created by our custom page.
  ${IfNot} ${isKeepShortcuts}
    WinShell::UninstShortcut "$oldDesktopLink"
    Delete "$oldDesktopLink"
  ${EndIf}
!macroend

!ifndef BUILD_UNINSTALLER
  !include nsDialogs.nsh
  Var MukaiDesktopShortcut
  Var MukaiDesktopCheckbox

  !macro customInit
    StrCpy $MukaiDesktopShortcut ${BST_CHECKED}
  !macroend

  !macro customWelcomePage
    !define MUI_WELCOMEPAGE_TITLE "Welcome to Mukai Setup"
    !define MUI_WELCOMEPAGE_TEXT "Setup will install Mukai for your Windows account.$\r$\n$\r$\nYou can choose where to install it and whether to add a desktop shortcut. A Start menu shortcut will be added automatically.$\r$\n$\r$\nClick Next to continue."
    !insertmacro MUI_PAGE_WELCOME
  !macroend

  !macro customPageAfterChangeDir
    Page custom MukaiShortcutPage MukaiShortcutPageLeave

    Function MukaiShortcutPage
      ${If} ${isUpdated}
        Abort
      ${EndIf}
      !insertmacro MUI_HEADER_TEXT "Shortcuts" "Choose how to open Mukai."
      nsDialogs::Create 1018
      Pop $0
      ${If} $0 == error
        Abort
      ${EndIf}
      ${NSD_CreateLabel} 0 0 100% 24u "Setup will add Mukai to your Start menu. You can also add a shortcut to your desktop."
      Pop $0
      ${NSD_CreateCheckbox} 0 36u 100% 12u "Create a desktop shortcut"
      Pop $MukaiDesktopCheckbox
      ${NSD_SetState} $MukaiDesktopCheckbox $MukaiDesktopShortcut
      nsDialogs::Show
    FunctionEnd

    Function MukaiShortcutPageLeave
      ${NSD_GetState} $MukaiDesktopCheckbox $MukaiDesktopShortcut
    FunctionEnd
  !macroend

  !macro customInstall
    ${If} $MukaiDesktopShortcut == ${BST_CHECKED}
    ${AndIfNot} ${isUpdated}
    ${AndIfNot} ${isNoDesktopShortcut}
      CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
      WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
    ${EndIf}
  !macroend
!endif
