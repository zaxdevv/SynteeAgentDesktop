// Монитор устройств вывода Windows: список + live peak-уровни (IAudioMeterInformation).
// Работает через PowerShell + встроенный C# (COM MMDevice API) — БЕЗ нативных
// модулей и БЕЗ смены системных настроек: только чтение.
// Захват звука для визуализатора — отдельно, в audioVisualizer.ipc.ts.
import { ipcMain } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { MainWindow } from '../windows/MainWindow'

export interface AudioOutputDevice {
  id: string
  name: string
  isDefault: boolean
  level: number
}

const POWERSHELL = 'powershell.exe'
let monitor: ChildProcessWithoutNullStreams | null = null
let stdoutBuffer = ''
let cachedDevices: AudioOutputDevice[] = []

const AUDIO_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential)]
public struct SynteePropertyKey {
    public Guid fmtid;
    public uint pid;
}

[StructLayout(LayoutKind.Explicit, Size = 24)]
public struct SynteePropVariant {
    [FieldOffset(0)] public ushort vt;
    [FieldOffset(8)] public IntPtr pointer;
}

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
public class SynteeMMDeviceEnumerator { }

[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface SynteeIMMDeviceEnumerator {
    int EnumAudioEndpoints(int dataFlow, uint stateMask, out SynteeIMMDeviceCollection devices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out SynteeIMMDevice device);
    int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out SynteeIMMDevice device);
    int RegisterEndpointNotificationCallback(IntPtr callback);
    int UnregisterEndpointNotificationCallback(IntPtr callback);
}

[ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface SynteeIMMDeviceCollection {
    int GetCount(out uint count);
    int Item(uint index, out SynteeIMMDevice device);
}

[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface SynteeIMMDevice {
    int Activate(ref Guid iid, uint clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.Interface)] out object instance);
    int OpenPropertyStore(uint access, out SynteeIPropertyStore store);
    int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    int GetState(out uint state);
}

[ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface SynteeIPropertyStore {
    int GetCount(out uint count);
    int GetAt(uint index, out SynteePropertyKey key);
    int GetValue(ref SynteePropertyKey key, out SynteePropVariant value);
    int SetValue(ref SynteePropertyKey key, ref SynteePropVariant value);
    int Commit();
}

[ComImport, Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface SynteeIAudioMeterInformation {
    int GetPeakValue(out float peak);
    int GetMeteringChannelCount(out uint count);
    int GetChannelsPeakValues(uint count, [Out] float[] values);
    int QueryHardwareSupport(out uint support);
}

public sealed class SynteeAudioOutput {
    public string id { get; set; }
    public string name { get; set; }
    public bool isDefault { get; set; }
    public float level { get; set; }
}

public static class SynteeAudioNative {
    private const uint DEVICE_STATE_ACTIVE = 1;
    private const uint CLSCTX_ALL = 23;
    private static readonly Guid IID_AUDIO_METER = new Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064");
    private static readonly SynteePropertyKey FRIENDLY_NAME = new SynteePropertyKey {
        fmtid = new Guid("A45C254E-DF1C-4EFD-8020-67D146A850E0"), pid = 14
    };

    private static SynteeIMMDeviceEnumerator Enumerator() {
        return (SynteeIMMDeviceEnumerator)new SynteeMMDeviceEnumerator();
    }

    private static string Name(SynteeIMMDevice device, string fallback) {
        try {
            SynteeIPropertyStore store;
            if (device.OpenPropertyStore(0, out store) == 0) {
                SynteePropVariant value;
                // static readonly нельзя передавать по ref вне статического конструктора — копируем в локальную.
                SynteePropertyKey nameKey = FRIENDLY_NAME;
                if (store.GetValue(ref nameKey, out value) == 0) {
                    string result = value.vt == 31 && value.pointer != IntPtr.Zero
                        ? Marshal.PtrToStringUni(value.pointer)
                        : fallback;
                    try { Marshal.FinalReleaseComObject(store); } catch { }
                    try { NativeMethods.PropVariantClear(ref value); } catch { }
                    return result ?? fallback;
                }
            }
        } catch { }
        return fallback;
    }

    private static float Level(SynteeIMMDevice device) {
        try {
            object instance;
            Guid iid = IID_AUDIO_METER;
            if (device.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out instance) == 0) {
                SynteeIAudioMeterInformation meter = (SynteeIAudioMeterInformation)instance;
                float peak;
                meter.GetPeakValue(out peak);
                try { Marshal.FinalReleaseComObject(meter); } catch { }
                return Math.Max(0f, Math.Min(1f, peak));
            }
        } catch { }
        return 0f;
    }

    public static SynteeAudioOutput[] Read() {
        SynteeIMMDeviceEnumerator enumerator = Enumerator();
        SynteeIMMDevice defaultDevice;
        string defaultId = "";
        try {
            if (enumerator.GetDefaultAudioEndpoint(0, 1, out defaultDevice) == 0) defaultDevice.GetId(out defaultId);
        } catch { }

        SynteeIMMDeviceCollection collection;
        if (enumerator.EnumAudioEndpoints(0, DEVICE_STATE_ACTIVE, out collection) != 0) return new SynteeAudioOutput[0];
        uint count;
        collection.GetCount(out count);
        var result = new List<SynteeAudioOutput>();
        for (uint i = 0; i < count; i++) {
            SynteeIMMDevice device;
            if (collection.Item(i, out device) != 0) continue;
            string id;
            device.GetId(out id);
            result.Add(new SynteeAudioOutput {
                id = id,
                name = Name(device, id),
                isDefault = id == defaultId,
                level = Level(device)
            });
        }
        return result.ToArray();
    }

    private static class NativeMethods {
        [DllImport("ole32.dll")]
        public static extern int PropVariantClear(ref SynteePropVariant value);
    }
}
'@

while ($true) {
  try {
    $json = ConvertTo-Json -Compress -InputObject @([SynteeAudioNative]::Read())
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
  } catch {
    [Console]::Error.WriteLine($_.Exception.Message)
  }
  Start-Sleep -Milliseconds 180
}
`

function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

function sendToWindow(mainWindow: MainWindow, channel: string, payload: unknown): void {
  try { mainWindow.getWindow()?.webContents.send(channel, payload) } catch { /* window may be closing */ }
}

function startMonitor(mainWindow: MainWindow): void {
  if (monitor && monitor.exitCode === null) return
  const encoded = encodePowerShell(AUDIO_SCRIPT)
  monitor = spawn(POWERSHELL, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', encoded,
  ], { windowsHide: true })
  stdoutBuffer = ''
  monitor.stdout.setEncoding('utf8')
  monitor.stdout.on('data', (chunk: string) => {
    stdoutBuffer += chunk
    const lines = stdoutBuffer.split(/\r?\n/)
    stdoutBuffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const devices = JSON.parse(line) as AudioOutputDevice[]
        if (!Array.isArray(devices)) continue
        cachedDevices = devices.map(device => ({
          id: String(device.id),
          name: String(device.name),
          isDefault: Boolean(device.isDefault),
          level: Math.max(0, Math.min(1, Number(device.level) || 0)),
        }))
        sendToWindow(mainWindow, 'audioDevices:update', cachedDevices)
      } catch { /* PowerShell can emit non-JSON diagnostics; ignore them */ }
    }
  })
  monitor.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim()
    if (!text) return
    // PowerShell пишет CLIXML-прогресс («Подготовка модулей») в stderr — это шум, не ошибка.
    if (text.startsWith('#< CLIXML') || text.includes('<Objs')) return
    console.warn('[audio-devices]', text)
  })
  monitor.on('exit', () => {
    monitor = null
    sendToWindow(mainWindow, 'audioDevices:stopped', undefined)
  })
}

function stopMonitor(): void {
  if (!monitor) return
  monitor.kill()
  monitor = null
}

export function registerAudioDevicesIPC(mainWindow: MainWindow): void {
  ipcMain.handle('audioDevices:startMonitor', () => {
    startMonitor(mainWindow)
    return cachedDevices
  })
  ipcMain.handle('audioDevices:stopMonitor', () => {
    stopMonitor()
    return true
  })
  ipcMain.handle('audioDevices:list', () => cachedDevices)
}

export function stopAudioDevicesIPC(): void {
  stopMonitor()
}
