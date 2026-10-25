using System.Collections.Concurrent;
using Windows.Media;
using Windows.Storage.Streams;

namespace NoxSmtc;

/// <summary>
/// Windows medya kontrolleri (SMTC), uygulamanın kendi penceresine ve kendi işlemine bağlı.
/// Electron ana işleminde node-api-dotnet ile yüklenir; ayrı bir yardımcı işlem yoktur.
/// Windows olayları iş parçacığı havuzundan gelir; JS tarafı onları <see cref="TakeEvents"/> ile alır,
/// böylece hiçbir JS çağrısı yabancı bir iş parçacığından yapılmaz.
/// </summary>
public static class Bridge
{
    private static SystemMediaTransportControls? controls;
    private static readonly ConcurrentQueue<string> events = new();
    private static InMemoryRandomAccessStream? thumbnail;

    /// <summary>SMTC'yi pencereye bağlar. <paramref name="hwnd"/> BrowserWindow.getNativeWindowHandle() değeridir.</summary>
    public static string Init(double hwnd)
    {
        if (controls is not null) return "ok";
        try
        {
            controls = SystemMediaTransportControlsInterop.GetForWindow((nint)(long)hwnd);
            // İlk parça gelene kadar kapalı: boş bir oturum Windows'un "geçerli oturumu" olup
            // başka bir uygulamada çalanı Noxelyra'dan ve medya kartından gizlemesin.
            controls.IsEnabled = false;
            controls.IsPlayEnabled = true; controls.IsPauseEnabled = true; controls.IsStopEnabled = true;
            controls.IsNextEnabled = true; controls.IsPreviousEnabled = true;
            controls.IsFastForwardEnabled = false; controls.IsRewindEnabled = false;
            controls.PlaybackStatus = MediaPlaybackStatus.Closed;
            controls.ButtonPressed += (_, e) => events.Enqueue(e.Button switch
            {
                SystemMediaTransportControlsButton.Play => "play",
                SystemMediaTransportControlsButton.Pause => "pause",
                SystemMediaTransportControlsButton.Stop => "stop",
                SystemMediaTransportControlsButton.Next => "next",
                SystemMediaTransportControlsButton.Previous => "previous",
                _ => "none",
            });
            controls.PlaybackPositionChangeRequested += (_, e) =>
                events.Enqueue("seek " + e.RequestedPlaybackPosition.TotalMilliseconds.ToString(System.Globalization.CultureInfo.InvariantCulture));
            return "ok";
        }
        catch (Exception ex) { controls = null; return ex.GetType().Name + ": " + ex.Message; }
    }

    /// <summary>
    /// Başlık, sanatçı, albüm ve kare kapak (PNG/JPEG, base64). Video içerik de Music türüyle yayınlanır:
    /// Video türünde sanatçı alanı yoktur ve Noxelyra/Windows sanatçıyı boş gösterir (Chromium da hep Music kullanır).
    /// </summary>
    public static void SetMetadata(string title, string artist, string album, string coverBase64)
    {
        if (controls is null) return;
        controls.IsEnabled = true;
        var updater = controls.DisplayUpdater;
        updater.ClearAll();
        updater.Type = MediaPlaybackType.Music;
        updater.MusicProperties.Title = title;
        updater.MusicProperties.Artist = artist;
        updater.MusicProperties.AlbumTitle = album;
        updater.MusicProperties.AlbumArtist = artist;
        thumbnail?.Dispose(); thumbnail = null;
        if (!string.IsNullOrEmpty(coverBase64))
        {
            var bytes = Convert.FromBase64String(coverBase64);
            var stream = new InMemoryRandomAccessStream();
            using (var writer = new DataWriter(stream.GetOutputStreamAt(0)))
            {
                writer.WriteBytes(bytes);
                writer.StoreAsync().AsTask().GetAwaiter().GetResult();
                writer.FlushAsync().AsTask().GetAwaiter().GetResult();
                writer.DetachStream();
            }
            stream.Seek(0);
            thumbnail = stream;
            updater.Thumbnail = RandomAccessStreamReference.CreateFromStream(stream);
        }
        updater.Update();
    }

    /// <summary>"playing", "paused", "stopped" veya "closed".</summary>
    public static void SetStatus(string status)
    {
        if (controls is null) return;
        controls.PlaybackStatus = status switch
        {
            "playing" => MediaPlaybackStatus.Playing,
            "paused" => MediaPlaybackStatus.Paused,
            "stopped" => MediaPlaybackStatus.Stopped,
            "changing" => MediaPlaybackStatus.Changing,
            _ => MediaPlaybackStatus.Closed,
        };
    }

    /// <summary>Zaman çizelgesi. <paramref name="seekable"/> false ise (canlı yayın) sarma kapalı bildirilir.</summary>
    public static void SetTimeline(double positionMs, double durationMs, bool seekable)
    {
        if (controls is null) return;
        if (!double.IsFinite(durationMs) || durationMs < 0) durationMs = 0;
        if (!double.IsFinite(positionMs) || positionMs < 0) positionMs = 0;
        if (durationMs > 0 && positionMs > durationMs) positionMs = durationMs;
        var end = TimeSpan.FromMilliseconds(durationMs);
        var timeline = new SystemMediaTransportControlsTimelineProperties
        {
            StartTime = TimeSpan.Zero,
            EndTime = end,
            MinSeekTime = TimeSpan.Zero,
            MaxSeekTime = seekable ? end : TimeSpan.Zero,
            Position = TimeSpan.FromMilliseconds(positionMs),
        };
        controls.UpdateTimelineProperties(timeline);
    }

    public static void SetCommands(bool canPrevious, bool canNext, bool canPlayPause)
    {
        if (controls is null) return;
        controls.IsPreviousEnabled = canPrevious; controls.IsNextEnabled = canNext;
        controls.IsPlayEnabled = canPlayPause; controls.IsPauseEnabled = canPlayPause;
    }

    /// <summary>Bekleyen Windows komutları, satır satır ("play", "next", "seek 12345" ...).</summary>
    public static string TakeEvents()
    {
        if (events.IsEmpty) return "";
        var list = new List<string>();
        while (events.TryDequeue(out var e)) if (e != "none") list.Add(e);
        return string.Join("\n", list);
    }

    /// <summary>
    /// Pencereyi Windows'un "her zaman üstte" katmanına koyar ya da çıkarır (mini oynatıcı için).
    /// Electron'un setAlwaysOnTop'u durumu önbellekte tuttuğundan Windows bayrağı silince geri koymuyor.
    /// </summary>
    public static bool SetTopmost(double hwnd, bool on)
    {
        const uint NoMove = 0x2, NoSize = 0x1, NoActivate = 0x10;
        return SetWindowPos((nint)(long)hwnd, on ? -1 : -2, 0, 0, 0, 0, NoMove | NoSize | NoActivate);
    }

    /// <summary>Pencere şu an "her zaman üstte" mi (WS_EX_TOPMOST).</summary>
    public static bool IsTopmost(double hwnd) => (GetWindowLongPtr((nint)(long)hwnd, -20) & 0x8) != 0;

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern bool SetWindowPos(nint hwnd, nint after, int x, int y, int width, int height, uint flags);
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern nint GetWindowLongPtr(nint hwnd, int index);

    public static void Clear()
    {
        if (controls is null) return;
        controls.DisplayUpdater.ClearAll(); controls.DisplayUpdater.Update();
        controls.PlaybackStatus = MediaPlaybackStatus.Closed;
        controls.IsEnabled = false;
        thumbnail?.Dispose(); thumbnail = null;
    }
}
