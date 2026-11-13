package cn.codex.companion;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.location.LocationManager;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.wifi.WifiInfo;
import android.net.wifi.WifiManager;
import android.graphics.Color;
import android.graphics.Insets;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.text.InputFilter;
import android.provider.Settings;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsAnimation;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.HashMap;
import java.util.Map;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

public final class MainActivity extends Activity {
    private FrameLayout root;
    private WebView webView;
    private ProgressBar progress;
    private SharedPreferences preferences;
    private volatile boolean keepAwake = true;
    private volatile boolean fullscreen;
    private boolean resumed;
    private boolean mainFrameFailed;
    private volatile String trustedOrigin = "";
    private String retryUrl;
    private ComputerDiscovery discovery;
    private LinearLayout computerList;
    private TextView wifiLabel, discoveryStatus;
    private Button connectCode;
    private EditText codeInput;
    private TextView pairingError;
    private String selectedOrigin = "", selectedId = "";
    private int pairingGeneration;
    private boolean rediscoverRemembered;
    private String failedRestoreOrigin = "";
    private WindowInsetsAnimation keyboardAnimation;
    private int keyboardBottom;
    private final Map<String, String> discovered = new HashMap<>();
    private final ExecutorService networkWorker = Executors.newSingleThreadExecutor();

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        preferences = getSharedPreferences("companion", MODE_PRIVATE);
        keepAwake = preferences.getBoolean("keep_awake", true);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        if (Build.VERSION.SDK_INT >= 30) getWindow().setDecorFitsSystemWindows(false);
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.rgb(245, 245, 247));
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                applyVisibleInsets(insets);
                return WindowInsets.CONSUMED;
            }
            view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(), insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets.consumeSystemWindowInsets();
        });
        if (Build.VERSION.SDK_INT >= 30) {
            root.setWindowInsetsAnimationCallback(new WindowInsetsAnimation.Callback(WindowInsetsAnimation.Callback.DISPATCH_MODE_STOP) {
                @Override public void onPrepare(WindowInsetsAnimation animation) {
                    if ((animation.getTypeMask() & WindowInsets.Type.ime()) == 0) return;
                    keyboardAnimation = animation;
                }

                @Override public WindowInsetsAnimation.Bounds onStart(WindowInsetsAnimation animation, WindowInsetsAnimation.Bounds bounds) {
                    // Send only the destination and duration. The page animates
                    // its composer on the compositor; the WebView stays still.
                    if (animation == keyboardAnimation) publishKeyboard(animation.getDurationMillis());
                    return bounds;
                }

                @Override public WindowInsets onProgress(WindowInsets insets, List<WindowInsetsAnimation> runningAnimations) {
                    return insets;
                }

                @Override public void onEnd(WindowInsetsAnimation animation) {
                    if (animation != keyboardAnimation) return;
                    keyboardAnimation = null;
                    WindowInsets insets = root.getRootWindowInsets();
                    if (insets != null) applyVisibleInsets(insets);
                }
            });
        }
        setContentView(root);
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        root.requestApplyInsets();
        String shared = sharedLink(getIntent());
        if (shared != null) showPairing(shared);
        else {
            String saved = preferences.getString("computer_origin", "");
            try { if (!saved.isEmpty()) { loadRemembered(PairingAddress.parse(saved, false)); return; } }
            catch (IllegalArgumentException ignored) { preferences.edit().remove("computer_origin").apply(); }
            showPairing("");
        }
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        String shared = sharedLink(intent);
        if (shared != null) showPairing(shared);
    }

    private String sharedLink(Intent intent) {
        return intent != null && Intent.ACTION_SEND.equals(intent.getAction()) && "text/plain".equals(intent.getType()) ? intent.getStringExtra(Intent.EXTRA_TEXT) : null;
    }

    private int dp(float value) { return Math.round(value * getResources().getDisplayMetrics().density); }

    private void publishKeyboard(long duration) {
        if (webView == null || Build.VERSION.SDK_INT < 30) return;
        webView.evaluateJavascript("window.companionKeyboard={bottomPx:" + keyboardBottom + ",durationMs:" + Math.max(0, duration)
            + "};window.dispatchEvent(new Event('companionkeyboardchange'));", null);
    }

    private void applyVisibleInsets(WindowInsets insets) {
        if (Build.VERSION.SDK_INT < 30) return;
        Insets safe = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
        int imeBottom = insets.getInsets(WindowInsets.Type.ime()).bottom;
        if (webView != null) {
            // Keep the browser viewport independent of the IME, including the
            // navigation bar that the keyboard may reveal in fullscreen.
            safe = Insets.max(insets.getInsets(WindowInsets.Type.displayCutout()), fullscreen ? Insets.NONE
                : insets.getInsetsIgnoringVisibility(WindowInsets.Type.systemBars()));
        }
        int bottom = webView != null ? safe.bottom : Math.max(safe.bottom, imeBottom);
        if (root.getPaddingLeft() != safe.left || root.getPaddingTop() != safe.top || root.getPaddingRight() != safe.right || root.getPaddingBottom() != bottom) {
            root.setPadding(safe.left, safe.top, safe.right, bottom);
        }
        keyboardBottom = Math.max(0, imeBottom - safe.bottom);
        if (keyboardAnimation == null) publishKeyboard(0);
    }

    private GradientDrawable surface(int color, int radius) {
        GradientDrawable shape = new GradientDrawable();
        shape.setColor(color);
        shape.setCornerRadius(dp(radius));
        shape.setStroke(dp(1), Color.WHITE);
        return shape;
    }

    private TextView text(String content, int size, int color, boolean bold) {
        TextView view = new TextView(this);
        view.setText(content);
        view.setTextSize(size);
        view.setTextColor(color);
        view.setLineSpacing(dp(4), 1);
        if (bold) view.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        return view;
    }

    private Button button(String label, boolean primary) {
        Button view = new Button(this);
        view.setText(label);
        view.setAllCaps(false);
        view.setTextSize(15);
        view.setTextColor(primary ? Color.WHITE : Color.rgb(0, 122, 255));
        view.setMinHeight(dp(50));
        view.setBackground(surface(primary ? Color.rgb(0, 122, 255) : 0xB3FFFFFF, 25));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, dp(50));
        params.topMargin = dp(14);
        view.setLayoutParams(params);
        return view;
    }

    private void destroyBrowser() {
        if (webView != null) {
            root.removeView(webView);
            webView.stopLoading();
            webView.removeJavascriptInterface("CodexCompanion");
            webView.destroy();
            webView = null;
        }
        root.removeAllViews();
    }

    private LinearLayout nativePage(String title, String subtitle) {
        destroyBrowser();
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        root.requestApplyInsets();
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setBackground(new GradientDrawable(GradientDrawable.Orientation.TL_BR, new int[]{0xFFE0EAF9, 0xFFF0EBFA, 0xFFF5F5F7}));
        LinearLayout column = new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setGravity(Gravity.CENTER_VERTICAL);
        column.setPadding(dp(24), dp(32), dp(24), dp(32));
        scroll.addView(column, new ScrollView.LayoutParams(-1, -1));
        column.addView(text("Codex 副屏", 18, 0xFF5C6577, true));
        TextView heading = text(title, 30, 0xFF1D1D1F, true);
        heading.setPadding(0, dp(30), 0, dp(12));
        column.addView(heading);
        column.addView(text(subtitle, 15, 0xFF6C7484, false));
        root.addView(scroll, new FrameLayout.LayoutParams(-1, -1));
        return column;
    }

    private void showPairing(String initial) {
        setFullscreen(false);
        if (discovery != null) { discovery.stop(); discovery = null; }
        pairingGeneration++;
        selectedOrigin = "";
        selectedId = "";
        discovered.clear();
        LinearLayout column = nativePage("输入 6 位配对码", "手机与电脑连接同一 Wi-Fi。\n电脑副屏页面点击「连接手机」，查看配对码。");
        wifiLabel = text("", 14, 0xFF5D718E, true);
        wifiLabel.setPadding(0, dp(20), 0, dp(4));
        column.addView(wifiLabel);
        refreshWifi();
        Button wifiPermission = button("显示 Wi-Fi 名称", false);
        wifiPermission.setOnClickListener(view -> requestWifiName());
        column.addView(wifiPermission);
        discoveryStatus = text("正在寻找这台 Wi-Fi 下的电脑…", 13, 0xFF8991A1, false);
        discoveryStatus.setPadding(0, dp(22), 0, dp(6));
        column.addView(discoveryStatus);
        computerList = new LinearLayout(this);
        computerList.setOrientation(LinearLayout.VERTICAL);
        column.addView(computerList);
        codeInput = new EditText(this);
        codeInput.setHint("000000");
        codeInput.setInputType(InputType.TYPE_CLASS_NUMBER);
        codeInput.setFilters(new InputFilter[]{new InputFilter.LengthFilter(6)});
        codeInput.setSingleLine(true);
        codeInput.setTextSize(32);
        codeInput.setLetterSpacing(.2f);
        codeInput.setGravity(Gravity.CENTER);
        codeInput.setTextColor(0xFF26334C);
        codeInput.setHintTextColor(0xFFA6AFBF);
        codeInput.setPadding(dp(16), dp(18), dp(16), dp(18));
        codeInput.setBackground(surface(0xCFFFFFFF, 18));
        LinearLayout.LayoutParams codeParams = new LinearLayout.LayoutParams(-1, -2);
        codeParams.topMargin = dp(24);
        column.addView(codeInput, codeParams);
        pairingError = text("", 13, 0xFFD92D37, false);
        pairingError.setVisibility(View.GONE);
        column.addView(pairingError);
        connectCode = button("配对并连接", true);
        connectCode.setEnabled(false);
        connectCode.setOnClickListener(view -> pairByCode());
        column.addView(connectCode);
        Button manual = button("找不到电脑？手动填写地址", false);
        manual.setOnClickListener(view -> manualComputer());
        column.addView(manual);
        Button legacy = button("使用完整配对链接", false);
        legacy.setOnClickListener(view -> legacyLink(initial));
        column.addView(legacy);
        TextView tip = text("配对后自动记住设备，电脑服务重启无需重新输入。\nWi-Fi 名称仅用于本机展示，不会上传。", 12, 0xFF8991A1, false);
        tip.setPadding(0, dp(24), 0, 0);
        column.addView(tip);
        discovery = new ComputerDiscovery(this, (origin, id, name) -> {
            if (computerList == null || discovered.containsKey(id)) return;
            discovered.put(id, origin);
            if (rediscoverRemembered && id.equals(preferences.getString("computer_id", "")) && !origin.equals(failedRestoreOrigin)) {
                rediscoverRemembered = false;
                loadRemembered(PairingAddress.parse(origin, false));
                return;
            }
            Button computer = button(name + "  ·  " + origin.replace("http://", ""), false);
            computer.setOnClickListener(view -> selectComputer(origin, id, name));
            computerList.addView(computer);
            if (selectedOrigin.isEmpty()) selectComputer(origin, id, name);
            if (discovered.size() > 1) discoveryStatus.setText("找到多台电脑，请点击要连接的电脑");
        });
        discovery.start();
        String saved = preferences.getString("computer_origin", "");
        if (!saved.isEmpty()) discovery.probe(saved);
        if (initial != null && !initial.isEmpty()) legacyLink(initial);
    }

    private void selectComputer(String origin, String id, String name) {
        selectedOrigin = origin;
        selectedId = id;
        discoveryStatus.setText("已选择：" + name + "\n" + origin);
        connectCode.setEnabled(true);
    }

    private void refreshWifi() {
        if (wifiLabel == null) return;
        try {
            ConnectivityManager connectivity = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
            Network network = connectivity.getActiveNetwork();
            NetworkCapabilities capabilities = connectivity.getNetworkCapabilities(network);
            if (capabilities == null || !capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) {
                wifiLabel.setText("当前 Wi-Fi：未连接或正在使用移动网络 / VPN");
                return;
            }
            if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
                wifiLabel.setText("当前 Wi-Fi：已连接（点下方授权显示名称）");
                return;
            }
            LocationManager location = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
            boolean enabled = Build.VERSION.SDK_INT >= 28 ? location.isLocationEnabled() : location.isProviderEnabled(LocationManager.GPS_PROVIDER) || location.isProviderEnabled(LocationManager.NETWORK_PROVIDER);
            if (!enabled) { wifiLabel.setText("当前 Wi-Fi：已连接（开启系统定位后显示名称）"); return; }
            WifiManager wifi = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            WifiInfo info = wifi.getConnectionInfo();
            String ssid = info == null ? null : info.getSSID();
            if (ssid == null || ssid.equals("<unknown ssid>")) wifiLabel.setText("当前 Wi-Fi：已连接（系统未提供名称）");
            else wifiLabel.setText("当前 Wi-Fi：" + ssid.replaceAll("^\"|\"$", ""));
        } catch (RuntimeException unavailable) { wifiLabel.setText("当前 Wi-Fi：系统暂不允许读取名称"); }
    }

    private void requestWifiName() {
        new AlertDialog.Builder(this).setTitle("显示当前 Wi-Fi 名称")
            .setMessage("Android 将 Wi-Fi 名称归为位置信息，需要精确位置权限，并可能要求开启系统定位。仅在此页面读取 Wi-Fi 名称，不读取 GPS、不上传；拒绝也可以继续配对。")
            .setPositiveButton("继续", (dialog, which) -> {
                if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) requestPermissions(new String[]{Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION}, 24);
                else { refreshWifi(); startActivity(new Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS)); }
            }).setNegativeButton("暂不", null).show();
    }

    @Override public void onRequestPermissionsResult(int request, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(request, permissions, results);
        if (request == 24) refreshWifi();
    }

    private void manualComputer() {
        EditText address = new EditText(this);
        address.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        address.setHint("192.168.x.x:18377");
        new AlertDialog.Builder(this).setTitle("电脑局域网地址").setMessage("在电脑副屏的链接连接区域可查看地址。端口默认 18377。").setView(address)
            .setPositiveButton("查找", (dialog, which) -> {
                String value = address.getText().toString().trim();
                if (!value.contains("://")) value = "http://" + value;
                try {
                    PairingAddress parsed = PairingAddress.parse(value, false);
                    String origin = parsed.origin;
                    if (new java.net.URI(origin).getPort() == -1) origin += ":18377";
                    selectComputer(origin, "", "手动填写的电脑");
                    discovery.probe(origin);
                } catch (Exception invalid) { Toast.makeText(this, "请输入有效的局域网 IPv4 地址", Toast.LENGTH_SHORT).show(); }
            }).setNegativeButton("取消", null).show();
    }

    private void legacyLink(String initial) {
        EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setText(initial);
        input.setHint("http://192.168.…:18377/#pair=…");
        new AlertDialog.Builder(this).setTitle("完整配对链接").setView(input)
            .setNeutralButton("粘贴", (dialog, which) -> {
                ClipboardManager clipboard = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                ClipData clip = clipboard.getPrimaryClip();
                if (clip != null && clip.getItemCount() > 0) legacyLink(clip.getItemAt(0).coerceToText(this).toString());
            }).setPositiveButton("连接", (dialog, which) -> {
                try {
                    PairingAddress address = PairingAddress.parse(input.getText().toString(), true);
                    input.setText("");
                    getIntent().removeExtra(Intent.EXTRA_TEXT);
                    loadComputer(address);
                } catch (IllegalArgumentException invalid) { Toast.makeText(this, "请使用完整配对链接", Toast.LENGTH_SHORT).show(); }
            }).setNegativeButton("取消", null).show();
    }

    private JSONObject post(String origin, String path, JSONObject data, StringBuilder cookie) throws Exception {
        HttpURLConnection request = (HttpURLConnection) new URL(origin + path).openConnection();
        try {
            request.setConnectTimeout(5000);
            request.setReadTimeout(5000);
            request.setInstanceFollowRedirects(false);
            request.setRequestMethod("POST");
            request.setDoOutput(true);
            request.setRequestProperty("Content-Type", "application/json");
            byte[] payload = data.toString().getBytes("UTF-8");
            request.setFixedLengthStreamingMode(payload.length);
            try (java.io.OutputStream output = request.getOutputStream()) { output.write(payload); }
            int status = request.getResponseCode();
            InputStream input = status == 200 ? request.getInputStream() : request.getErrorStream();
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            if (input != null) try (InputStream source = input) { byte[] buffer = new byte[1024]; int count; while ((count = source.read(buffer)) != -1 && bytes.size() < 8192) bytes.write(buffer, 0, count); }
            JSONObject result = new JSONObject(bytes.toString("UTF-8"));
            if (status != 200) throw new IllegalArgumentException(result.optString("error", "连接失败，请重试"));
            String setCookie = request.getHeaderField("Set-Cookie");
            if (setCookie == null || !setCookie.startsWith("companion_session=")) throw new IllegalArgumentException("电脑未返回配对会话，请更新电脑服务");
            cookie.append(setCookie);
            return result;
        } finally { request.disconnect(); }
    }

    private void pairByCode() {
        String code = codeInput.getText().toString();
        if (!code.matches("[0-9]{6}")) { pairingError.setText("请输入电脑上显示的 6 位数字"); pairingError.setVisibility(View.VISIBLE); return; }
        final String origin = selectedOrigin, id = selectedId;
        final int generation = pairingGeneration;
        connectCode.setEnabled(false);
        connectCode.setText("正在配对…");
        pairingError.setVisibility(View.GONE);
        networkWorker.execute(() -> {
            try {
                JSONObject body = new JSONObject().put("code", code).put("deviceName", Build.MANUFACTURER + " " + Build.MODEL);
                StringBuilder cookie = new StringBuilder();
                JSONObject response = post(origin, "/api/pair-code", body, cookie);
                String pairedId = response.getString("serverId");
                if (!id.isEmpty() && !id.equals(pairedId)) throw new IllegalArgumentException("电脑身份已变化，请重新查找");
                String token = cookie.toString().substring("companion_session=".length()).split(";", 2)[0];
                runOnUiThread(() -> {
                    if (generation != pairingGeneration || isFinishing()) return;
                    rediscoverRemembered = false;
                    preferences.edit().putString("computer_origin", origin).putString("computer_id", pairedId).putString("device_token", token).apply();
                    codeInput.setText("");
                    CookieManager.getInstance().setCookie(origin, cookie.toString(), accepted -> loadComputer(PairingAddress.parse(origin, false)));
                });
            } catch (Exception failure) {
                runOnUiThread(() -> {
                    if (generation != pairingGeneration || isFinishing()) return;
                    connectCode.setEnabled(true);
                    connectCode.setText("配对并连接");
                    pairingError.setText(failure instanceof IllegalArgumentException ? failure.getMessage() : "连接失败，请确认电脑服务已启动、手机与电脑在同一 Wi-Fi。");
                    pairingError.setVisibility(View.VISIBLE);
                });
            }
        });
    }

    private void loadRemembered(PairingAddress address) {
        if (discovery != null) { discovery.stop(); discovery = null; }
        computerList = null;
        wifiLabel = null;
        String token = preferences.getString("device_token", "");
        if (token.isEmpty()) { loadComputer(address); return; }
        final String expectedId = preferences.getString("computer_id", "");
        final int generation = pairingGeneration;
        nativePage("正在连接你的电脑", "正在恢复已配对设备…");
        networkWorker.execute(() -> {
            try {
                HttpURLConnection identity = (HttpURLConnection) new URL(address.origin + "/api/discovery").openConnection();
                identity.setConnectTimeout(3000);
                identity.setReadTimeout(3000);
                identity.setInstanceFollowRedirects(false);
                try {
                    ByteArrayOutputStream bytes = new ByteArrayOutputStream();
                    try (InputStream input = identity.getInputStream()) { byte[] buffer = new byte[1024]; int count; while ((count = input.read(buffer)) != -1 && bytes.size() < 4096) bytes.write(buffer, 0, count); }
                    if (!expectedId.equals(new JSONObject(bytes.toString("UTF-8")).optString("serverId"))) throw new IllegalArgumentException("电脑身份已变化，请重新配对");
                } finally { identity.disconnect(); }
                StringBuilder cookie = new StringBuilder();
                JSONObject result = post(address.origin, "/api/device-session", new JSONObject().put("deviceToken", token), cookie);
                if (!expectedId.equals(result.optString("serverId"))) throw new IllegalArgumentException("电脑身份已变化，请重新配对");
                runOnUiThread(() -> {
                    if (generation != pairingGeneration || isFinishing()) return;
                    CookieManager.getInstance().setCookie(address.origin, cookie.toString(), accepted -> loadComputer(address));
                });
            } catch (Exception failure) {
                runOnUiThread(() -> {
                    if (!isFinishing() && generation == pairingGeneration) {
                        failedRestoreOrigin = address.origin;
                        rediscoverRemembered = !(failure instanceof IllegalArgumentException);
                        showPairing("");
                        if (rediscoverRemembered) discoveryStatus.setText("正在查找已配对的电脑，找到后将自动重连…");
                    }
                });
            }
        });
    }

    private void loadComputer(PairingAddress address) {
        pairingGeneration++;
        if (discovery != null) { discovery.stop(); discovery = null; }
        wifiLabel = null;
        computerList = null;
        destroyBrowser();
        trustedOrigin = address.origin;
        retryUrl = address.url;
        mainFrameFailed = false;
        webView = new WebView(this);
        if (Build.VERSION.SDK_INT >= 30) getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setSafeBrowsingEnabled(true);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false);
        webView.setBackgroundColor(0xFFF5F5F7);
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        webView.addJavascriptInterface(new NativeBridge(), "CodexCompanion");
        webView.setWebChromeClient(new WebChromeClient() {
            @Override public void onProgressChanged(WebView view, int value) {
                if (progress != null) { progress.setProgress(value); progress.setVisibility(value >= 100 ? View.GONE : View.VISIBLE); }
            }
        });
        webView.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (PairingAddress.sameOrigin(request.getUrl().toString(), trustedOrigin)) return false;
                String scheme = request.getUrl().getScheme();
                // A deliberate Markdown link opens outside the privileged
                // WebView. Scripts, redirects and custom schemes stay blocked.
                if (request.isForMainFrame() && request.hasGesture() && ("https".equals(scheme) || "http".equals(scheme))) {
                    try { startActivity(new Intent(Intent.ACTION_VIEW, request.getUrl()).addCategory(Intent.CATEGORY_BROWSABLE)); }
                    catch (ActivityNotFoundException ignored) { Toast.makeText(MainActivity.this, "未找到可打开链接的浏览器", Toast.LENGTH_SHORT).show(); }
                }
                return true;
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                if (PairingAddress.sameOrigin(request.getUrl().toString(), trustedOrigin)) return null;
                return new WebResourceResponse("text/plain", "UTF-8", new ByteArrayInputStream(new byte[0]));
            }
            @Override public void onPageFinished(WebView view, String url) {
                if (mainFrameFailed || !PairingAddress.sameOrigin(url, trustedOrigin)) return;
                // Only the origin is stored; pairing fragments are exchanged for HttpOnly cookies.
                preferences.edit().putString("computer_origin", trustedOrigin).apply();
                CookieManager.getInstance().flush();
                retryUrl = trustedOrigin + "/";
                publishKeyboard(0);
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (!request.isForMainFrame()) return;
                mainFrameFailed = true;
                root.post(() -> showConnectionError());
            }
        });
        root.addView(webView, new FrameLayout.LayoutParams(-1, -1));
        root.requestApplyInsets();
        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progress.setMax(100);
        FrameLayout.LayoutParams bar = new FrameLayout.LayoutParams(-1, dp(2), Gravity.TOP);
        root.addView(progress, bar);
        webView.loadUrl(address.url);
    }

    private void showConnectionError() {
        if (isFinishing() || isDestroyed()) return;
        final String retry = retryUrl;
        LinearLayout column = nativePage("暂时连接不上电脑", "请确认手机与电脑在同一 Wi-Fi，并且电脑上的副屏服务正在运行。\n\n连接地址：" + trustedOrigin);
        Button again = button("重新连接", true);
        again.setOnClickListener(view -> {
            try { loadComputer(PairingAddress.parse(retry, false)); }
            catch (IllegalArgumentException invalid) { showPairing(""); }
        });
        column.addView(again);
        Button change = button("更换电脑 / 重新配对", false);
        change.setOnClickListener(view -> showPairing(""));
        column.addView(change);
    }

    private void connectionMenu() {
        new AlertDialog.Builder(this).setTitle("Codex 副屏")
            .setMessage((trustedOrigin.isEmpty() ? "尚未连接电脑" : "当前电脑：" + trustedOrigin) + "\n屏幕常亮：" + (keepAwake ? "已开启（应用前台）" : "已关闭"))
            .setPositiveButton("返回副屏", (dialog, which) -> {})
            .setNeutralButton("重新配对", (dialog, which) -> { rediscoverRemembered = false; showPairing(""); })
            .setNegativeButton("重新加载", (dialog, which) -> {
                if (webView != null) { mainFrameFailed = false; webView.reload(); }
                else showPairing("");
            }).show();
    }

    private void applyKeepAwake() {
        if (resumed && keepAwake) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }

    private void setFullscreen(boolean enabled) {
        fullscreen = enabled;
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController controller = getWindow().getInsetsController();
            if (controller != null) {
                controller.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                if (enabled) controller.hide(WindowInsets.Type.systemBars());
                else controller.show(WindowInsets.Type.systemBars());
            }
        } else {
            getWindow().getDecorView().setSystemUiVisibility(enabled ? View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY : View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        }
        if (webView != null) webView.evaluateJavascript("window.dispatchEvent(new Event('nativefullscreenchange'))", null);
        root.requestApplyInsets();
    }

    private final class NativeBridge {
        @JavascriptInterface public boolean keyboardOverlaySupported() { return Build.VERSION.SDK_INT >= 30; }
        @JavascriptInterface public String appVersion() {
            try { return getPackageManager().getPackageInfo(getPackageName(), 0).versionName; }
            catch (PackageManager.NameNotFoundException ignored) { return ""; }
        }
        @JavascriptInterface public boolean isKeepAwakeEnabled() { return keepAwake; }
        @JavascriptInterface public void setKeepAwake(boolean enabled) {
            runOnUiThread(() -> {
                keepAwake = enabled;
                preferences.edit().putBoolean("keep_awake", enabled).apply();
                applyKeepAwake();
            });
        }
        @JavascriptInterface public boolean isFullscreen() { return fullscreen; }
        @JavascriptInterface public void toggleFullscreen() { runOnUiThread(() -> setFullscreen(!fullscreen)); }
        @JavascriptInterface public void openConnectionSettings() { runOnUiThread(() -> connectionMenu()); }
        @JavascriptInterface public void pairComputer() { runOnUiThread(() -> { rediscoverRemembered = false; showPairing(""); }); }
    }

    @Override protected void onResume() {
        super.onResume();
        resumed = true;
        applyKeepAwake();
        if (webView != null) webView.onResume();
        refreshWifi();
    }

    @Override protected void onPause() {
        resumed = false;
        applyKeepAwake();
        if (webView != null) { webView.onPause(); CookieManager.getInstance().flush(); }
        super.onPause();
    }

    @Override public void onBackPressed() {
        if (webView == null) { super.onBackPressed(); return; }
        if (fullscreen) { setFullscreen(false); return; }
        webView.evaluateJavascript("(function(){var d=document.querySelector('dialog[open]:not(#loginDialog)');if(d){d.close();return true;}return false;})()", closed -> {
            if (!"true".equals(closed)) connectionMenu();
        });
    }

    @Override protected void onDestroy() {
        pairingGeneration++;
        resumed = false;
        applyKeepAwake();
        if (discovery != null) discovery.stop();
        networkWorker.shutdownNow();
        destroyBrowser();
        super.onDestroy();
    }
}
