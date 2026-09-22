# Teste: enumera sessoes de audio (apps tocando som). Sintaxe C# 5 (PowerShell 5.1).
$cs = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class AudioSessions {
    public class Session { public string Name; public int ProcessId; public float Volume; }

    static IAudioSessionEnumerator GetSessions() {
        IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
        IMMDevice device;
        enumerator.GetDefaultAudioEndpoint(0, 1, out device);
        Guid iid = new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");
        object mgr;
        device.Activate(ref iid, 0, IntPtr.Zero, out mgr);
        IAudioSessionEnumerator se;
        ((IAudioSessionManager2)mgr).GetSessionEnumerator(out se);
        return se;
    }

    public static List<Session> ListSessions() {
        List<Session> list = new List<Session>();
        HashSet<int> seen = new HashSet<int>();
        IAudioSessionEnumerator se = GetSessions();
        int count;
        se.GetCount(out count);
        for (int i = 0; i < count; i++) {
            IAudioSessionControl control;
            se.GetSession(i, out control);
            IAudioSessionControl2 c2 = control as IAudioSessionControl2;
            if (c2 == null) continue;
            int pid;
            c2.GetProcessId(out pid);
            if (pid == 0 || seen.Contains(pid)) continue;
            seen.Add(pid);
            System.Diagnostics.Process proc = System.Diagnostics.Process.GetProcessById(pid);
            float vol = 1;
            ISimpleAudioVolume sav = control as ISimpleAudioVolume;
            if (sav != null) sav.GetMasterVolume(out vol);
            list.Add(new Session { Name = proc.ProcessName + ".exe", ProcessId = pid, Volume = vol });
        }
        return list;
    }

    public static void SetVolume(string processName, float volume) {
        IAudioSessionEnumerator se = GetSessions();
        int count;
        se.GetCount(out count);
        string target = processName.Replace(".exe", "");
        for (int i = 0; i < count; i++) {
            IAudioSessionControl control;
            se.GetSession(i, out control);
            IAudioSessionControl2 c2 = control as IAudioSessionControl2;
            if (c2 == null) continue;
            int pid;
            c2.GetProcessId(out pid);
            if (pid == 0) continue;
            System.Diagnostics.Process proc = System.Diagnostics.Process.GetProcessById(pid);
            if (proc.ProcessName.Equals(target, StringComparison.OrdinalIgnoreCase)) {
                ISimpleAudioVolume sav = control as ISimpleAudioVolume;
                if (sav != null) {
                    Guid ctx = Guid.Empty;
                    sav.SetMasterVolume(volume, ref ctx);
                }
            }
        }
    }
}
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
public class MMDeviceEnumerator { }

[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDeviceEnumerator {
    void EnumAudioEndpoints(int d, int m, out IntPtr p);
    void GetDefaultAudioEndpoint(int d, int r, out IMMDevice e);
    void RegisterEndpointNotificationCallback(IntPtr n);
    void UnregisterEndpointNotificationCallback(IntPtr n);
}

[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDevice {
    void Activate([In] ref Guid iid, [In] uint dwClsCtx, [In] IntPtr pActivationParams,
        [Out, MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
}

[ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioSessionManager2 {
    void GetAudioSessionControl(ref Guid g, uint f, out IntPtr c);
    void GetSimpleAudioVolume(ref Guid g, uint f, out IntPtr v);
    void GetSessionEnumerator(out IAudioSessionEnumerator e);
    void RegisterSessionNotification(IntPtr n);
    void UnregisterSessionNotification(IntPtr n);
    void RegisterDuckNotification(string s, IntPtr d);
    void UnregisterDuckNotification(IntPtr d);
}

[ComImport, Guid("641DD20B-4D41-49CC-ABA3-174B9477BB08"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioSessionEnumerator {
    void GetCount(out int SessionCount);
    void GetSession(int SessionCount, out IAudioSessionControl Session);
}

[ComImport, Guid("F4B1A599-7266-4319-A8CA-E70ACB11E8CD"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioSessionControl {
    void GetState(out int s);
    void GetDisplayName(out IntPtr d);
    void SetDisplayName(string v, ref Guid c);
    void GetIconPath(out IntPtr p);
    void SetIconPath(string v, ref Guid c);
    void GetGroupingParam(out Guid g);
    void SetGroupingParam(ref Guid o, ref Guid c);
    void RegisterSessionNotification(IntPtr n);
    void UnregisterSessionNotification(IntPtr n);
}

[ComImport, Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioSessionControl2 {
    void GetState(out int s);
    void GetDisplayName(out IntPtr d);
    void SetDisplayName(string v, ref Guid c);
    void GetIconPath(out IntPtr p);
    void SetIconPath(string v, ref Guid c);
    void GetGroupingParam(out Guid g);
    void SetGroupingParam(ref Guid o, ref Guid c);
    void RegisterSessionNotification(IntPtr n);
    void UnregisterSessionNotification(IntPtr n);
    void GetSessionIdentifier(out IntPtr i);
    void GetSessionInstanceIdentifier(out IntPtr i);
    void GetProcessId(out int p);
    void IsSystemSoundsSession();
    void SetDuckingPreference(bool o);
}


public interface ISimpleAudioVolume {
    void SetMasterVolume(float l, ref Guid c);
    void GetMasterVolume(out float l);
    void SetMute(bool m, ref Guid c);
    void GetMute(out bool m);
}
'@

Add-Type -TypeDefinition $cs -Language CSharp -ErrorAction Stop
"=== Compilou OK ==="

$sessions = [AudioSessions]::ListSessions()
"=== Sessoes com audio: $($sessions.Count) ==="
$sessions | Format-Table -AutoSize | Out-String
