package cn.codex.companion;

public class PairingAddressTest {
    private static int checks;
    private static void check(boolean value) {
        checks++;
        if (!value) throw new AssertionError("Check " + checks + " failed");
    }
    private static void rejects(String input, boolean token) {
        try { PairingAddress.parse(input, token); throw new AssertionError("Unexpected address accepted"); }
        catch (IllegalArgumentException expected) { checks++; }
    }
    public static void main(String[] args) {
        String token = "#pair=abcdefghijklmnopqrstuvwxyz_123456";
        PairingAddress address = PairingAddress.parse(" http://192.168.1.5:18377/" + token + " ", true);
        check(address.origin.equals("http://192.168.1.5:18377"));
        check(address.url.equals(address.origin + "/" + token));
        check(!address.origin.contains("pair="));
        check(PairingAddress.parse("https://10.0.0.5/", false).origin.equals("https://10.0.0.5"));
        check(PairingAddress.parse("http://172.31.4.9" + token, true).url.contains("/#pair="));
        check(PairingAddress.sameOrigin(address.origin + "/api/events", address.origin));
        check(PairingAddress.sameOrigin("http://192.168.1.5:80/", "http://192.168.1.5"));
        check(!PairingAddress.sameOrigin("http://192.168.1.5:9999/", address.origin));
        check(!PairingAddress.sameOrigin("https://192.168.1.5:18377/", address.origin));
        check(!PairingAddress.sameOrigin("http://192.168.1.50:18377/", address.origin));
        check(!PairingAddress.sameOrigin("http://evil@192.168.1.5:18377/", address.origin));
        for (String host : new String[]{"example.com", "127.0.0.1", "169.254.1.1", "172.32.1.1", "8.8.8.8", "192.168.256.1", "192.168.01.1", "192.168.1.5.evil.com"}) rejects("http://" + host + "/" + token, true);
        rejects("http://192.168.1.5/", true);
        rejects("http://192.168.1.5/" + "#pair=short", true);
        rejects("file:///etc/hosts", false);
        rejects("javascript:alert(1)", false);
        rejects("http://user:pass@192.168.1.5/" + token, true);
        rejects("http://192.168.1.5/path" + token, true);
        rejects("http://192.168.1.5/?token=abc" + token, true);
        rejects("http://192.168.1.5:99999/" + token, true);
        System.out.println("PairingAddress: " + checks + " checks passed");
    }
}
