# audio-volume.ps1 — enumera apps com áudio e controla o volume por processo.
# Usa WASAPI via C# embutido. Sem dependências externas.
param(
    [switch]$List,
    [string]$Set,
    [double]$Volume = 1.0
)

$code = @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class AudioSessions {

    [DllImport("ole32.dll")]
    static extern int CoInitializeEx(IntPtr pvReserved, uint dwCoInit);
    [DllImport("ole32.dll")]
    static extern void CoUninitialize();
    [DllImport("ole32.dll", PreserveSig = false)]
    static extern void CoCreateInstance([In] ref Guid rclsid, [In] IntPtr pUnkOuter,
        [In] uint dwClsContext, [In] ref Guid riid, [Out] out IntPtr ppv);

    public class Session {
        public string Name;
        public int ProcessId;
        public float Volume;
    }

    static IMMDeviceEnumerator GetEnumerator() {
        Guid clsid = new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E");
        Guid iid = new Guid("A95664D2-9614-4F35-A746-DE8DB63617E6");
        IntPtr ptr;
        CoCreateInstance(ref clsid, IntPtr.Zero, 1, ref iid, out ptr);
        return (IMMDeviceEnumerator)Marshal.GetObjectForIUnknown(ptr);
    }

    static IAudioSessionEnumerator GetSessionEnumerator() {
        IMMDevice device;
        GetEnumerator().GetDefaultAudioEndpoint(EDataFlow.eRender, ERole.eMultimedia, out device);
        Guid iid2 = new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");
        object mgr;
        device.Activate(ref iid2, 0, IntPtr.Zero, out mgr);
        IAudioSessionEnumerator se;
        ((IAudioSessionManager2)mgr).GetSessionEnumerator(out se);
        return se;
    }

    public static List<Session> ListSessions() {
        CoInitializeEx(IntPtr.Zero, 2);
        try {
            var se = GetSessionEnumerator();
            int count;
            se.GetCount(out count);
            var list = new List<Session>();
            var seen = new HashSet<int>();
            for (int i = 0; i < count; i++) {
                IAudioSessionControl control;
                se.GetSession(i, out control);
                var c2 = control as IAudioSessionControl2;
                if (c2 == null) continue;
                int pid;
                c2.GetProcessId(out pid);
                if (pid == 0 || seen.Contains(pid)) continue;
                seen.Add(pid);
                var proc = System.Diagnostics.Process.GetProcessById(pid);
                float vol = 1;
                var sav = control as ISimpleAudioVolume;
                if (sav != null) sav.GetMasterVolume(out vol);
                list.Add(new Session { Name = proc.ProcessName + ".exe", ProcessId = pid, Volume = vol });
            }
            return list;
        } finally {
            CoUninitialize();
        }
    }
"@