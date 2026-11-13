package cn.codex.companion;

import java.net.URI;
import java.net.URISyntaxException;

/** Restrict the native shell to a computer on the user's private IPv4 LAN. */
public final class PairingAddress {
    public final String origin;
    public final String url;

    private PairingAddress(String origin, String url) {
        this.origin = origin;
        this.url = url;
    }

    public static PairingAddress parse(String input, boolean requireToken) {
        try {
            URI uri = new URI(input.trim());
            String scheme = uri.getScheme();
            if (!("http".equals(scheme) || "https".equals(scheme)) || uri.getUserInfo() != null || !isPrivateIp(uri.getHost())) throw new IllegalArgumentException();
            int port = uri.getPort();
            if (port == 0 || port > 65535 || port < -1) throw new IllegalArgumentException();
            String path = uri.getRawPath();
            if (!(path == null || path.isEmpty() || "/".equals(path)) || uri.getRawQuery() != null) throw new IllegalArgumentException();
            String fragment = uri.getRawFragment();
            if (fragment != null && !fragment.matches("pair=[A-Za-z0-9_-]{16,256}")) throw new IllegalArgumentException();
            if (requireToken && fragment == null) throw new IllegalArgumentException();
            String origin = scheme + "://" + uri.getHost() + (port == -1 ? "" : ":" + port);
            return new PairingAddress(origin, origin + "/" + (fragment == null ? "" : "#" + fragment));
        } catch (URISyntaxException | NullPointerException error) {
            throw new IllegalArgumentException("请粘贴电脑上「连接手机」生成的完整局域网配对链接。", error);
        }
    }

    public static boolean sameOrigin(String url, String origin) {
        try {
            URI target = new URI(url);
            URI trusted = new URI(origin);
            return trusted.getScheme().equals(target.getScheme()) && trusted.getHost().equals(target.getHost()) && effectivePort(trusted) == effectivePort(target) && target.getUserInfo() == null;
        } catch (Exception error) {
            return false;
        }
    }

    private static int effectivePort(URI uri) {
        return uri.getPort() >= 0 ? uri.getPort() : "https".equals(uri.getScheme()) ? 443 : 80;
    }

    private static boolean isPrivateIp(String host) {
        if (host == null) return false;
        String[] parts = host.split("\\.", -1);
        if (parts.length != 4) return false;
        int[] ip = new int[4];
        for (int i = 0; i < 4; i++) {
            if (!parts[i].matches("0|[1-9][0-9]{0,2}")) return false;
            ip[i] = Integer.parseInt(parts[i]);
            if (ip[i] > 255) return false;
        }
        return ip[0] == 10 || (ip[0] == 172 && ip[1] >= 16 && ip[1] <= 31) || (ip[0] == 192 && ip[1] == 168);
    }
}
