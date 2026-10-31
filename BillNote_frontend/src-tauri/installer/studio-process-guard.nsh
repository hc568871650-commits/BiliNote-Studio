; Tauri's default macro kills processes by filename, including other installations.
; Replace it with a stop-and-retry requirement for install and uninstall.
!ifmacrodef CheckIfAppIsRunning
  !macroundef CheckIfAppIsRunning
!endif
!macro CheckIfAppIsRunning executableName productName
  !if "${INSTALLMODE}" == "currentUser"
    nsis_tauri_utils::FindProcessCurrentUser "${executableName}"
  !else
    nsis_tauri_utils::FindProcess "${executableName}"
  !endif
  Pop $R0
  ${If} $R0 = 0
    SetErrorLevel 2
    Abort "请先从托盘退出 ${productName}，再重新运行安装或卸载程序。"
  ${EndIf}
!macroend
