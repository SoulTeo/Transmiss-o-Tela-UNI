using System.Diagnostics;
using System.Net.WebSockets;
using System.Runtime.InteropServices;
using System.Threading.Channels;
using NAudio.Wave;
using NAudio.CoreAudioApi;

var builder = WebApplication.CreateBuilder(args);
builder.WebHost.UseUrls("http://127.0.0.1:17381");
var app = builder.Build();
app.UseWebSockets(new WebSocketOptions { KeepAliveInterval = TimeSpan.FromSeconds(20) });

app.Use(async (context, next) =>
{
    var origin = context.Request.Headers.Origin.ToString();
    if (origin is "http://localhost:5173" or "http://127.0.0.1:5173")
    {
        context.Response.Headers.AccessControlAllowOrigin = origin;
        context.Response.Headers.AccessControlAllowMethods = "GET, OPTIONS";
        context.Response.Headers.AccessControlAllowHeaders = "Content-Type";
        context.Response.Headers["Access-Control-Allow-Private-Network"] = "true";
        context.Response.Headers.Vary = "Origin";
    }

    if (context.Request.Method == "OPTIONS")
    {
        context.Response.StatusCode = StatusCodes.Status204NoContent;
        return;
    }

    await next();
});

app.MapGet("/healthz", () => Results.Json(new { ok = true, capture = "windows-process-loopback" }));

app.MapGet("/api/windows", () => Results.Json(WindowCatalog.GetVisibleWindows()));

app.Map("/api/audio/{processId:int}", async context =>
{
    var origin = context.Request.Headers.Origin.ToString();
    if (origin is not ("http://localhost:5173" or "http://127.0.0.1:5173"))
    {
        context.Response.StatusCode = StatusCodes.Status403Forbidden;
        return;
    }
    if (!context.WebSockets.IsWebSocketRequest)
    {
        context.Response.StatusCode = StatusCodes.Status400BadRequest;
        return;
    }

    var processId = int.Parse((string)context.Request.RouteValues["processId"]!);
    if (processId <= 0 || !IsProcessRunning(processId))
    {
        context.Response.StatusCode = StatusCodes.Status404NotFound;
        return;
    }

    using var socket = await context.WebSockets.AcceptWebSocketAsync();
    using var lifetime = new CancellationTokenSource();
    var pendingAudio = Channel.CreateBounded<byte[]>(new BoundedChannelOptions(12)
    {
        FullMode = BoundedChannelFullMode.DropOldest,
        SingleReader = true,
        SingleWriter = false,
    });

    WasapiRecorder? recorder = null;
    try
    {
        await using (recorder = await new WasapiRecorderBuilder()
            .WithProcessLoopback((uint)processId, ProcessLoopbackMode.IncludeTargetProcessTree)
            .WithFormat(WaveFormat.CreateIeeeFloatWaveFormat(48000, 2))
            .BuildAsync())
        {
            await socket.SendAsync("ready"u8.ToArray(), WebSocketMessageType.Text, true, lifetime.Token);
            recorder.DataAvailable += (buffer, _, _, _) =>
            {
                if (!lifetime.IsCancellationRequested && buffer.Length > 0)
                    pendingAudio.Writer.TryWrite(buffer.ToArray());
            };
            recorder.StartRecording();

            var closeWatcher = WatchForClientClose(socket, lifetime);
            while (socket.State == WebSocketState.Open && !lifetime.IsCancellationRequested)
            {
                byte[] chunk;
                try
                {
                    chunk = await pendingAudio.Reader.ReadAsync(lifetime.Token);
                }
                catch (OperationCanceledException)
                {
                    break;
                }

                await socket.SendAsync(chunk, WebSocketMessageType.Binary, true, lifetime.Token);
            }
            lifetime.Cancel();
            await closeWatcher;
        }
    }
    catch (OperationCanceledException)
    {
        // Expected when the client stops sharing.
    }
    catch (WebSocketException)
    {
        // The page closed the audio socket while stopping the share.
    }
    catch (Exception exception)
    {
        if (socket.State == WebSocketState.Open)
        {
            var error = System.Text.Encoding.UTF8.GetBytes($"capture-error:{exception.Message}");
            await socket.SendAsync(error, WebSocketMessageType.Text, true, CancellationToken.None);
        }
        app.Logger.LogError(exception, "Process audio capture failed for PID {ProcessId}", processId);
    }
    finally
    {
        lifetime.Cancel();
        pendingAudio.Writer.TryComplete();
        if (socket.State == WebSocketState.Open)
            await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "Capture stopped", CancellationToken.None);
    }
});

app.Run();

static bool IsProcessRunning(int processId)
{
    try { return !Process.GetProcessById(processId).HasExited; }
    catch { return false; }
}

static async Task WatchForClientClose(WebSocket socket, CancellationTokenSource lifetime)
{
    var buffer = new byte[256];
    try
    {
        while (socket.State == WebSocketState.Open && !lifetime.IsCancellationRequested)
        {
            var result = await socket.ReceiveAsync(buffer, lifetime.Token);
            if (result.MessageType == WebSocketMessageType.Close) break;
        }
    }
    catch (OperationCanceledException) { }
    catch (WebSocketException) { }
    finally { lifetime.Cancel(); }
}

internal sealed record WindowInfo(string Handle, int ProcessId, string Title, string ProcessName);

internal static class WindowCatalog
{
    private delegate bool EnumWindowsCallback(nint handle, nint lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsCallback callback, nint lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(nint handle, System.Text.StringBuilder text, int maxCount);
    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(nint handle);
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(nint handle, out uint processId);

    public static IReadOnlyList<WindowInfo> GetVisibleWindows()
    {
        var windows = new List<WindowInfo>();
        EnumWindows((handle, _) =>
        {
            if (!IsWindowVisible(handle)) return true;
            var text = new System.Text.StringBuilder(512);
            if (GetWindowText(handle, text, text.Capacity) <= 0) return true;
            GetWindowThreadProcessId(handle, out var rawProcessId);
            if (rawProcessId == 0 || rawProcessId > int.MaxValue) return true;

            try
            {
                using var process = Process.GetProcessById((int)rawProcessId);
                windows.Add(new WindowInfo(handle.ToInt64().ToString(), (int)rawProcessId, text.ToString(), process.ProcessName));
            }
            catch { }
            return true;
        }, nint.Zero);

        return windows
            .GroupBy(window => new { window.Handle, window.ProcessId })
            .Select(group => group.First())
            .OrderBy(window => window.Title, StringComparer.CurrentCultureIgnoreCase)
            .ToArray();
    }
}
