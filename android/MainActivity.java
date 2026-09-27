package tz.co.nordictz.nexus;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.Manifest;
import android.webkit.PermissionRequest;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.util.Base64;
import android.view.View;
import android.view.Window;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import com.google.firebase.messaging.FirebaseMessaging;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

/** NORDIC NEXUS for Android – opens the live NEXUS web app full screen; receives push notifications (v1.2). */
public class MainActivity extends Activity {
    static final String HOME = "https://frankkashushura.github.io/nordic-nexus-app/";
    static final String APP_HOST = "frankkashushura.github.io";
    static final int FILE_REQ = 41;
    static final int MIC_REQ = 42;
    static final int NOTIF_REQ = 43;
    static volatile boolean visible = false;
    static MainActivity current;
    volatile String pushToken = "";
    boolean pageReady = false;
    PermissionRequest pendingMic;

    WebView web;
    ValueCallback<Uri[]> fileCallback;
    boolean showingOffline = false;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#182340"));
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(false);
        s.setUserAgentString(s.getUserAgentString() + " NordicNexusAndroid/1.2");
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);

        web.addJavascriptInterface(new Bridge(), "NexusAndroid");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return openOutside(url);
            }

            // Android 7+ calls this one (not in the Android 6 SDK used to build, so no @Override)
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                return openOutside(req.getUrl().toString());
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                // files saved by NEXUS (Excel, CSV, Word, backups) go to the phone's Downloads folder
                view.evaluateJavascript(
                    "window.NX_NATIVE_SAVE=function(name,blob){return new Promise(function(ok){var r=new FileReader();" +
                    "r.onload=function(){var d=String(r.result);NexusAndroid.save(name||'download',blob.type||'application/octet-stream',d.substring(d.indexOf(',')+1));ok();};" +
                    "r.readAsDataURL(blob);});};", null);
                pageReady = true;
                sendTokenToPage();
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
                if (req.isForMainFrame()) showOffline();
            }

            @Override
            public void onReceivedError(WebView view, int code, String desc, String url) {
                if (url != null && url.startsWith(HOME)) showOffline();
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            // voice notes in NEXUS chat: let the page use the microphone (asks the user once)
            @Override
            public void onPermissionRequest(final PermissionRequest req) {
                runOnUiThread(new Runnable() { public void run() {
                    boolean audio = false;
                    for (String r : req.getResources()) if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r)) audio = true;
                    Uri o = req.getOrigin();
                    if (!audio || o == null || !APP_HOST.equals(o.getHost())) { req.deny(); return; }
                    if (Build.VERSION.SDK_INT < 23 || checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                        req.grant(new String[]{ PermissionRequest.RESOURCE_AUDIO_CAPTURE });
                    } else {
                        if (pendingMic != null) pendingMic.deny();
                        pendingMic = req;
                        requestPermissions(new String[]{ Manifest.permission.RECORD_AUDIO }, MIC_REQ);
                    }
                }});
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> cb, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = cb;
                Intent pick = params.createIntent();
                if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE)
                    pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                try {
                    startActivityForResult(Intent.createChooser(pick, "Choose file"), FILE_REQ);
                } catch (ActivityNotFoundException e) {
                    fileCallback = null;
                    Toast.makeText(MainActivity.this, "No app found to pick files.", Toast.LENGTH_LONG).show();
                    return false;
                }
                return true;
            }
        });

        current = this;
        String open = getIntent() != null ? getIntent().getStringExtra("open") : null;
        if (open != null) web.loadUrl(HOME + "?open=" + Uri.encode(open));
        else if (state != null) web.restoreState(state);
        else web.loadUrl(HOME);

        // notifications: ask once (Android 13+), then get this phone's push address
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
                && !getPreferences(MODE_PRIVATE).getBoolean("askedPush", false)) {
            getPreferences(MODE_PRIVATE).edit().putBoolean("askedPush", true).apply();
            requestPermissions(new String[]{ Manifest.permission.POST_NOTIFICATIONS }, NOTIF_REQ);
        }
        refreshToken();
    }

    void refreshToken() {
        try {
            FirebaseMessaging.getInstance().getToken().addOnCompleteListener(t -> {
                if (t.isSuccessful() && t.getResult() != null) { pushToken = t.getResult(); runOnUiThread(this::sendTokenToPage); }
            });
        } catch (Exception ignored) { }
    }

    void setToken(String t) { pushToken = t == null ? "" : t; runOnUiThread(this::sendTokenToPage); }

    /** Give the web page this phone's push address, so NEXUS can register it for the signed-in person. */
    void sendTokenToPage() {
        if (!pageReady || pushToken.isEmpty() || showingOffline) return;
        String tok = pushToken.replaceAll("[^A-Za-z0-9_:\\-]", "");
        web.evaluateJavascript("window.NX_PUSH_TOKEN&&window.NX_PUSH_TOKEN('" + tok + "','android')", null);
    }

    /** Tapping a notification while the app is open: go straight to the right page. */
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        String open = intent.getStringExtra("open");
        if (open == null) return;
        String safe = open.replaceAll("[^A-Za-z0-9_:\\-]", "");
        if (pageReady && !showingOffline) web.evaluateJavascript("window.NX_OPEN?window.NX_OPEN('" + safe + "'):location.assign('" + HOME + "?open=" + safe + "')", null);
        else web.loadUrl(HOME + "?open=" + Uri.encode(open));
    }

    @Override protected void onResume() { super.onResume(); visible = true; current = this; }
    @Override protected void onDestroy() { if (current == this) current = null; super.onDestroy(); }

    /** Links to other websites (tender pages, documents, email, phone) open outside the app. */
    boolean openOutside(String url) {
        if (url == null) return false;
        if (url.startsWith("nexus-retry:")) { showingOffline = false; pageReady = false; web.loadUrl(HOME); return true; }
        Uri u = Uri.parse(url);
        String host = u.getHost();
        boolean web2 = "https".equals(u.getScheme()) || "http".equals(u.getScheme());
        if (web2 && host != null && host.equals(APP_HOST)) return false;
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, u));
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, "No app can open this link.", Toast.LENGTH_SHORT).show();
        }
        return true;
    }

    void showOffline() {
        if (showingOffline) return;
        showingOffline = true;
        pageReady = false;
        String html = "<html><head><meta name='viewport' content='width=device-width,initial-scale=1'></head>" +
            "<body style='margin:0;background:#182340;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;text-align:center'>" +
            "<div style='padding:24px'><h2 style='margin:0 0 10px'>NORDIC NEXUS</h2><p style='color:#C9D4E8'>No internet connection. Check mobile data or Wi-Fi, then try again.</p>" +
            "<a href='nexus-retry:go' style='display:inline-block;margin-top:14px;background:#539FDC;color:#0E1830;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:bold'>Try again</a></div></body></html>";
        web.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        if (req != FILE_REQ || fileCallback == null) { super.onActivityResult(req, res, data); return; }
        Uri[] result = null;
        if (res == RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                int n = data.getClipData().getItemCount();
                result = new Uri[n];
                for (int i = 0; i < n; i++) result[i] = data.getClipData().getItemAt(i).getUri();
            } else if (data.getData() != null) {
                result = new Uri[]{ data.getData() };
            }
        }
        fileCallback.onReceiveValue(result);
        fileCallback = null;
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] res) {
        if (code == NOTIF_REQ) { refreshToken(); return; }
        if (code != MIC_REQ || pendingMic == null) return;
        if (res.length > 0 && res[0] == PackageManager.PERMISSION_GRANTED) pendingMic.grant(new String[]{ PermissionRequest.RESOURCE_AUDIO_CAPTURE });
        else { pendingMic.deny(); Toast.makeText(this, "Microphone not allowed – voice notes need it.", Toast.LENGTH_LONG).show(); }
        pendingMic = null;
    }

    @Override
    public void onBackPressed() {
        if (showingOffline) { super.onBackPressed(); return; }
        web.evaluateJavascript(
            "(function(){var o=document.querySelector('#overlay');if(o&&o.firstChild&&window.closeDrawer){closeDrawer();return 'closed';}return 'none';})()",
            new ValueCallback<String>() {
                @Override public void onReceiveValue(String v) {
                    if (v != null && v.contains("closed")) return;
                    if (web.canGoBack()) web.goBack(); else MainActivity.super.onBackPressed();
                }
            });
    }

    @Override protected void onSaveInstanceState(Bundle out) { super.onSaveInstanceState(out); web.saveState(out); }
    @Override protected void onPause() { super.onPause(); visible = false; CookieManager.getInstance().flush(); }

    /** Receives files from the web page and saves them to Downloads. */
    class Bridge {
        /** This phone's push address ("" until Firebase has given one). */
        @JavascriptInterface
        public String getPushToken() { return pushToken; }

        /** "granted", "denied" or "ask" – whether NEXUS may show notifications on this phone. */
        @JavascriptInterface
        public String pushPermission() {
            if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return "ask";
            if (Build.VERSION.SDK_INT >= 24) return ((android.app.NotificationManager) getSystemService(NOTIFICATION_SERVICE)).areNotificationsEnabled() ? "granted" : "denied";
            return "granted";
        }

        /** Ask Android for permission to show notifications (Android 13+), or open the app's notification settings. */
        @JavascriptInterface
        public void askPush() {
            runOnUiThread(() -> {
                boolean granted = Build.VERSION.SDK_INT < 33 || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
                boolean askedBefore = getPreferences(MODE_PRIVATE).getBoolean("askedPush", false);
                if (!granted && (!askedBefore || shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS))) {
                    getPreferences(MODE_PRIVATE).edit().putBoolean("askedPush", true).apply();
                    requestPermissions(new String[]{ Manifest.permission.POST_NOTIFICATIONS }, NOTIF_REQ);
                } else if (Build.VERSION.SDK_INT >= 26) {   // blocked before, or switched off in settings: open NEXUS notification settings
                    try { startActivity(new Intent("android.settings.APP_NOTIFICATION_SETTINGS").putExtra("android.provider.extra.APP_PACKAGE", getPackageName())); } catch (Exception ignored) { }
                }
                refreshToken();
            });
        }

        @JavascriptInterface
        public void save(final String name, final String mime, final String base64) {
            final String safe = name.replaceAll("[\\\\/:*?\"<>|]", "_");
            String msg;
            try {
                byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
                if (Build.VERSION.SDK_INT >= 29) {
                    ContentResolver cr = getContentResolver();
                    ContentValues v = new ContentValues();
                    v.put("_display_name", safe);
                    v.put("mime_type", mime);
                    v.put("relative_path", "Download/NORDIC NEXUS");
                    Uri uri = cr.insert(Uri.parse("content://media/external/downloads"), v);
                    OutputStream os = cr.openOutputStream(uri);
                    os.write(bytes); os.close();
                    msg = "Saved to Downloads/NORDIC NEXUS: " + safe;
                } else {
                    File dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                    if (dir != null && !dir.exists()) dir.mkdirs();
                    File f = new File(dir, safe);
                    FileOutputStream os = new FileOutputStream(f);
                    os.write(bytes); os.close();
                    msg = "Saved: " + f.getAbsolutePath();
                }
            } catch (Exception e) {
                msg = "Could not save the file: " + e.getMessage();
            }
            final String m = msg;
            runOnUiThread(new Runnable() { public void run() { Toast.makeText(MainActivity.this, m, Toast.LENGTH_LONG).show(); } });
        }
    }
}
