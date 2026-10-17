#include <windows.h>
#include <stdio.h>

int WINAPI WinMain(HINSTANCE hInst, HINSTANCE hPrev, LPSTR lpCmd, int nShow) {
    // 启动器所在目录
    wchar_t dir[MAX_PATH];
    GetModuleFileNameW(NULL, dir, MAX_PATH);
    wchar_t *slash = wcsrchr(dir, L'\\');
    if (slash) slash[1] = 0; else return 1;

    // 同级目录下的核心 exe
    wchar_t target[MAX_PATH * 2];
    swprintf(target, L"%sKimiIDE-core.exe", dir);
    if (GetFileAttributesW(target) == INVALID_FILE_ATTRIBUTES) {
        MessageBoxW(NULL, L"未找到 KimiIDE-core.exe", L"Kimi C++ IDE", MB_ICONERROR);
        return 1;
    }

    // 命令行：核心 exe + --no-sandbox + 原样透传用户附加参数
    wchar_t args[32768];
    swprintf(args, L"\"%s\" --no-sandbox", target);
    int baseLen = lstrlenW(args);
    if (lpCmd && lpCmd[0]) {
        swprintf(args + baseLen, L" %S", lpCmd);
    }

    STARTUPINFOW si;
    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    PROCESS_INFORMATION pi;
    if (CreateProcessW(target, args, NULL, NULL, FALSE, 0, NULL, dir, &si, &pi)) {
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
        return 0;
    }
    wchar_t msg[1024];
    swprintf(msg, L"启动失败，错误码 %lu", GetLastError());
    MessageBoxW(NULL, msg, L"Kimi C++ IDE", MB_ICONERROR);
    return 1;
}
