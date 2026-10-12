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
import android.webkit.GeolocationPermissions;
import android.print.PrintAttributes;
import android.print.PrintManager;
import android.provider.MediaStore;
import androidx.core.content.FileProvider;
import java.util.ArrayList;
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

/** NORDIC NEXUS for Android – opens the live NEXUS web app full screen; receives push notifications; in-app browser for the Digital Hub (v1.3);
 *  v1.4: camera for video calls and photos, GPS position for HSE forms, print / Save as PDF of NEXUS forms and reports. */
public class MainActivity extends Activity {
    static final String HOME = "https://frankkashushura.github.io/nordic-nexus-app/";
    static final String APP_HOST = "frankkashushura.github.io";
    static final int FILE_REQ = 41;
    static final int MIC_REQ = 42;
    static final int NOTIF_REQ = 43;
    static final int LOC_REQ = 44;
    static final int CAM_REQ = 45;
    static volatile boolean visible = false;
    static MainActivity current;
    volatile String pushToken = "";
    boolean pageReady = false;
    PermissionRequest pendingMic;
    GeolocationPermissions.Callback pendingGeo; String pendingGeoOrigin;
    WebChromeClient.FileChooserParams pendingChooser;
    Uri camUri; File camFile;
    WebView printView;

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
        s.setGeolocationEnabled(true);
        s.setUserAgentString(s.getUserAgentString() + " NordicNexusAndroid/1.4");
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
            // voice notes, voice and video calls: let NEXUS use the microphone and camera (Android asks once)
            @Override
            public void onPermissionRequest(final PermissionRequest req) {
                runOnUiThread(new Runnable() { public void run() {
                    Uri o = req.getOrigin();
                    if (o == null || !APP_HOST.equals(o.getHost())) { req.deny(); return; }
                    ArrayList<String> need = new ArrayList<>();
                    for (String r : req.getResources()) {
                        if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r) && !has(Manifest.permission.RECORD_AUDIO)) need.add(Manifest.permission.RECORD_AUDIO);
                        if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r) && !has(Manifest.permission.CAMERA)) need.add(Manifest.permission.CAMERA);
                    }
                    if (need.isEmpty()) { grantMedia(req); return; }
                    if (pendingMic != null) pendingMic.deny();
                    pendingMic = req;
                    requestPermissions(need.toArray(new String[0]), MIC_REQ);
                }});
            }

            // GPS position for HSE forms (only for NEXUS itself)
            @Override
            public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback cb) {
                Uri o = Uri.parse(origin);
                if (o == null || !APP_HOST.equals(o.getHost())) { cb.invoke(origin, false, false); return; }
                if (has(Manifest.permission.ACCESS_FINE_LOCATION) || has(Manifest.permission.ACCESS_COARSE_LOCATION)) { cb.invoke(origin, true, false); return; }
                pendingGeo = cb; pendingGeoOrigin = origin;
                requestPermissions(new String[]{ Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION }, LOC_REQ);
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> cb, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = cb;
                // photos: offer the camera too (asks for camera permission once)
                if (wantsImages(params) && !has(Manifest.permission.CAMERA) && !getPreferences(MODE_PRIVATE).getBoolean("askedCam", false)) {
                    getPreferences(MODE_PRIVATE).edit().putBoolean("askedCam", true).apply();
                    pendingChooser = params;
                    requestPermissions(new String[]{ Manifest.permission.CAMERA }, CAM_REQ);
                    return true;
                }
                return launchChooser(params);
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

    boolean has(String p) { return Build.VERSION.SDK_INT < 23 || checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED; }

    void grantMedia(PermissionRequest req) {
        ArrayList<String> ok = new ArrayList<>();
        for (String r : req.getResources()) {
            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r) && has(Manifest.permission.RECORD_AUDIO)) ok.add(r);
            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r) && has(Manifest.permission.CAMERA)) ok.add(r);
        }
        if (ok.isEmpty()) req.deny(); else req.grant(ok.toArray(new String[0]));
    }

    boolean wantsImages(WebChromeClient.FileChooserParams p) {
        String[] t = p.getAcceptTypes();
        if (t == null || t.length == 0) return true;
        for (String a : t) if (a == null || a.isEmpty() || a.contains("image") || a.equals("*/*")) return true;
        return false;
    }

    boolean launchChooser(WebChromeClient.FileChooserParams params) {
        Intent pick = params.createIntent();
        if (params.getMode() == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE) pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        Intent chooser = Intent.createChooser(pick, "Choose file");
        camUri = null; camFile = null;
        if (wantsImages(params) && has(Manifest.permission.CAMERA)) {
            try {
                File dir = new File(getCacheDir(), "cam"); dir.mkdirs();
                camFile = new File(dir, "NEXUS_" + System.currentTimeMillis() + ".jpg");
                camUri = FileProvider.getUriForFile(this, getPackageName() + ".files", camFile);
                Intent cam = new Intent(MediaStore.ACTION_IMAGE_CAPTURE).putExtra(MediaStore.EXTRA_OUTPUT, camUri)
                    .addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
                chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, new Intent[]{ cam });
            } catch (Exception e) { camUri = null; camFile = null; }
        }
        try {
            startActivityForResult(chooser, FILE_REQ);
            return true;
        } catch (ActivityNotFoundException e) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = null;
            Toast.makeText(this, "No app found to pick files.", Toast.LENGTH_LONG).show();
            return false;
        }
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
        if (result == null && res == RESULT_OK && camFile != null && camFile.length() > 0) result = new Uri[]{ camUri };   // photo taken with the camera
        fileCallback.onReceiveValue(result);
        fileCallback = null;
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] res) {
        if (code == NOTIF_REQ) { refreshToken(); return; }
        if (code == LOC_REQ) {
            boolean ok = false; for (int r : res) if (r == PackageManager.PERMISSION_GRANTED) ok = true;
            if (pendingGeo != null) pendingGeo.invoke(pendingGeoOrigin, ok, false);
            if (!ok) Toast.makeText(this, "Location not allowed – the GPS position needs it.", Toast.LENGTH_LONG).show();
            pendingGeo = null; return;
        }
        if (code == CAM_REQ) { if (pendingChooser != null) launchChooser(pendingChooser); pendingChooser = null; return; }
        if (code != MIC_REQ || pendingMic == null) return;
        grantMedia(pendingMic);
        boolean all = true; for (int r : res) if (r != PackageManager.PERMISSION_GRANTED) all = false;
        if (!all) Toast.makeText(this, "Microphone / camera not allowed – calls and voice notes need them.", Toast.LENGTH_LONG).show();
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
        /** v1.3: open a website inside NEXUS (in-app browser screen). */
        @JavascriptInterface
        public void openInApp(final String url) {
            if (url == null || !(url.startsWith("https://") || url.startsWith("http://"))) return;
            runOnUiThread(() -> {
                try { startActivity(new Intent(MainActivity.this, BrowserActivity.class).setData(Uri.parse(url))); }
                catch (Exception e) { openOutside(url); }
            });
        }

        /** v1.4: print a NEXUS form or report – Android's print screen also offers "Save as PDF" and sharing. */
        @JavascriptInterface
        public void printHtml(final String html, final String title) {
            if (html == null) return;
            runOnUiThread(() -> {
                final WebView pv = new WebView(MainActivity.this);
                pv.getSettings().setJavaScriptEnabled(false);
                pv.setWebViewClient(new WebViewClient() {
                    @Override public void onPageFinished(WebView v, String url) {
                        try {
                            String name = (title == null || title.trim().isEmpty() ? "NEXUS document" : title.trim()).replaceAll("[\\\\/:*?\"<>|]", "_");
                            PrintManager pm = (PrintManager) getSystemService(PRINT_SERVICE);
                            pm.print(name, v.createPrintDocumentAdapter(name), new PrintAttributes.Builder().setMediaSize(PrintAttributes.MediaSize.ISO_A4).build());
                        } catch (Exception e) { Toast.makeText(MainActivity.this, "Could not print: " + e.getMessage(), Toast.LENGTH_LONG).show(); }
                    }
                });
                printView = pv;   // keep it alive while Android prepares the document
                pv.loadDataWithBaseURL(HOME, html, "text/html", "utf-8", null);
            });
        }

        /** App version, so NEXUS knows which phone features are available. */
        @JavascriptInterface
        public String version() { return "1.4"; }

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
