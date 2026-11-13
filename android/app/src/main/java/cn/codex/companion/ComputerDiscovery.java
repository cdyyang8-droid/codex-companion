package cn.codex.companion;

import android.content.Context;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Handler;
import android.os.Looper;
import org.json.JSONObject;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayDeque;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Bonjour discovery, with no subnet scanning and no pairing-code broadcasts. */
public final class ComputerDiscovery {
    public interface Listener { void found(String origin, String id, String name); }
    private final NsdManager manager;
    private final Listener listener;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final ArrayDeque<NsdServiceInfo> pending = new ArrayDeque<>();
    private final Set<String> resolving = new HashSet<>();
    private final WifiManager.MulticastLock multicast;
    private NsdManager.DiscoveryListener discovery;
    private volatile boolean active;
    private boolean busy;

    public ComputerDiscovery(Context context, Listener listener) {
        manager = (NsdManager) context.getSystemService(Context.NSD_SERVICE);
        WifiManager wifi = (WifiManager) context.getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        multicast = wifi.createMulticastLock("codex-discovery");
        multicast.setReferenceCounted(false);
        this.listener = listener;
    }

    public void start() {
        if (active) return;
        active = true;
        try { multicast.acquire(); } catch (RuntimeException ignored) {}
        discovery = new NsdManager.DiscoveryListener() {
            @Override public void onDiscoveryStarted(String type) {}
            @Override public void onDiscoveryStopped(String type) {}
            @Override public void onStartDiscoveryFailed(String type, int code) {}
            @Override public void onStopDiscoveryFailed(String type, int code) {}
            @Override public void onServiceLost(NsdServiceInfo service) {}
            @Override public void onServiceFound(NsdServiceInfo service) {
                handler.post(() -> {
                    if (!active || !service.getServiceType().contains("_codexcomp._tcp") || !resolving.add(service.getServiceName())) return;
                    pending.add(service);
                    resolveNext();
                });
            }
        };
        try { manager.discoverServices("_codexcomp._tcp.", NsdManager.PROTOCOL_DNS_SD, discovery); }
        catch (RuntimeException ignored) {}
    }

    private void resolveNext() {
        if (!active || busy || pending.isEmpty()) return;
        busy = true;
        try { manager.resolveService(pending.remove(), new NsdManager.ResolveListener() {
            @Override public void onResolveFailed(NsdServiceInfo service, int code) { handler.post(() -> { busy = false; resolveNext(); }); }
            @Override public void onServiceResolved(NsdServiceInfo service) {
                if (active) {
                    if (android.os.Build.VERSION.SDK_INT >= 34) {
                        for (java.net.InetAddress address : service.getHostAddresses()) if (address instanceof java.net.Inet4Address) probe("http://" + address.getHostAddress() + ":" + service.getPort());
                    } else if (service.getHost() instanceof java.net.Inet4Address) probe("http://" + service.getHost().getHostAddress() + ":" + service.getPort());
                }
                handler.post(() -> { busy = false; resolveNext(); });
            }
        }); } catch (RuntimeException failure) { busy = false; resolveNext(); }
    }

    public void probe(String origin) {
        if (!active) return;
        try { worker.execute(() -> {
            HttpURLConnection connection = null;
            try {
                PairingAddress.parse(origin, false);
                connection = (HttpURLConnection) new URL(origin + "/api/discovery").openConnection();
                connection.setConnectTimeout(2500);
                connection.setReadTimeout(2500);
                connection.setInstanceFollowRedirects(false);
                if (connection.getResponseCode() != 200) return;
                java.io.ByteArrayOutputStream bytes = new java.io.ByteArrayOutputStream();
                try (java.io.InputStream input = connection.getInputStream()) { byte[] data = new byte[1024]; int size; while ((size = input.read(data)) != -1 && bytes.size() < 4096) bytes.write(data, 0, size); }
                JSONObject result = new JSONObject(bytes.toString("UTF-8"));
                if (!"codex-companion".equals(result.optString("app"))) return;
                String id = result.getString("serverId"), name = result.getString("computerName");
                handler.post(() -> { if (active) listener.found(origin, id, name); });
            } catch (Exception ignored) {
            } finally { if (connection != null) connection.disconnect(); }
        }); } catch (java.util.concurrent.RejectedExecutionException stopped) { /* Page was closed. */ }
    }

    public void stop() {
        active = false;
        if (discovery != null) { try { manager.stopServiceDiscovery(discovery); } catch (RuntimeException ignored) {} }
        if (multicast.isHeld()) multicast.release();
        worker.shutdownNow();
    }
}
