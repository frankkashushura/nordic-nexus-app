package tz.co.nordictz.nexus;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

/** NEXUS in-app browser (v1.3): websites and social networks from the Digital Hub open inside NEXUS.
 *  Top bar: close, page title + address, refresh, open in the phone's browser. Back goes back in the page history. */
public class BrowserActivity extends Activity {
    static final int NAVY = Color.parseColor("#182340");
    static final int FILE_REQ = 51;
    WebView web;
    TextView title, host;
    ProgressBar bar;
    ValueCallback<Uri[]> fileCallback;

    int dp(float v) { return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics()); }

    TextView button(String glyph, String desc, View.OnClickListener l) {
        TextView b = new TextView(this);
        b.setText(glyph); b.setTextColor(Color.WHITE); b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 20);
        b.setGravity(Gravity.CENTER); b.setContentDescription(desc); b.setOnClickListener(l);
        TypedValue tv = new TypedValue();
        if (getTheme().resolveAttribute(android.R.attr.selectableItemBackgroundBorderless, tv, true)) b.setBackgroundResource(tv.resourceId);
        b.setLayoutParams(new LinearLayout.LayoutParams(dp(48), dp(48)));
        return b;
    }

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        if (Build.VERSION.SDK_INT >= 21) { getWindow().setStatusBarColor(NAVY); getWindow().setNavigationBarColor(NAVY); }
        String url = getIntent().getDataString();
        if (url == null || !(url.startsWith("https://") || url.startsWith("http://"))) { finish(); return; }

        LinearLayout root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); root.setBackgroundColor(Color.WHITE);

        LinearLayout top = new LinearLayout(this); top.setOrientation(LinearLayout.HORIZONTAL); top.setGravity(Gravity.CENTER_VERTICAL);
        top.setBackgroundColor(NAVY); top.setPadding(dp(4), 0, dp(4), 0);
        top.addView(button("✕", "Close – back to NEXUS", v -> finish()));
        LinearLayout mid = new LinearLayout(this); mid.setOrientation(LinearLayout.VERTICAL); mid.setPadding(dp(6), 0, dp(6), 0);
        title = new TextView(this); title.setTextColor(Color.WHITE); title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15); title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setSingleLine(true); title.setEllipsize(TextUtils.TruncateAt.END); title.setText("Loading…");
        host = new TextView(this); host.setTextColor(Color.parseColor("#AFC4E4")); host.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        host.setSingleLine(true); host.setEllipsize(TextUtils.TruncateAt.MIDDLE);
        mid.addView(title); mid.addView(host);
        top.addView(mid, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        top.addView(button("⟳", "Refresh", v -> web.reload()));
        top.addView(button("↗", "Open in browser", v -> openExternal(web.getUrl())));
        root.addView(top, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(56)));

        bar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        bar.setMax(100);
        bar.setProgressTintList(android.content.res.ColorStateList.valueOf(Color.parseColor("#F5B301")));
        bar.setProgressBackgroundTintList(android.content.res.ColorStateList.valueOf(NAVY));
        root.addView(bar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(3)));

        web = new WebView(this);
        root.addView(web, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        setContentView(root);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(true); s.setBuiltInZoomControls(true); s.setDisplayZoomControls(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setSupportMultipleWindows(false);   // "open in new tab" links stay in this screen
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);

        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView v, String u) { return route(u); }
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) { return route(r.getUrl().toString()); }
            @Override public void onPageStarted(WebView v, String u, Bitmap f) { showHost(u); bar.setVisibility(View.VISIBLE); }
            @Override public void onPageFinished(WebView v, String u) { showHost(u); bar.setVisibility(View.GONE); if (v.getTitle() != null && v.getTitle().length() > 0) title.setText(v.getTitle()); }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onProgressChanged(WebView v, int p) { bar.setProgress(p); bar.setVisibility(p < 100 ? View.VISIBLE : View.GONE); }
            @Override public void onReceivedTitle(WebView v, String t) { if (t != null && t.length() > 0) title.setText(t); }
            @Override public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = cb;
                try { startActivityForResult(params.createIntent(), FILE_REQ); }
                catch (ActivityNotFoundException e) { fileCallback = null; return false; }
                return true;
            }
        });
        web.setDownloadListener((u, ua, cd, mime, len) -> openExternal(u));   // files download through the phone's browser
        web.loadUrl(url);
    }

    void showHost(String u) { try { host.setText(Uri.parse(u).getHost()); } catch (Exception e) { host.setText(u); } }

    /** Web pages stay here. App links (WhatsApp, phone, email, maps, Play Store) and Google sign-in go to the phone. */
    boolean route(String u) {
        if (u == null) return true;
        Uri uri = Uri.parse(u);
        String scheme = uri.getScheme() == null ? "" : uri.getScheme();
        if (scheme.equals("https") || scheme.equals("http")) {
            String h = uri.getHost() == null ? "" : uri.getHost();
            if (h.equals("accounts.google.com")) {   // Google does not allow signing in inside apps
                Toast.makeText(this, "Google sign-in opens in your phone's browser.", Toast.LENGTH_LONG).show();
                openExternal(u); return true;
            }
            return false;
        }
        if (scheme.equals("intent")) {
            try {
                Intent i = Intent.parseUri(u, Intent.URI_INTENT_SCHEME);
                i.addCategory(Intent.CATEGORY_BROWSABLE); i.setComponent(null); i.setSelector(null);
                try { startActivity(i); } catch (ActivityNotFoundException e) {
                    String fb = i.getStringExtra("browser_fallback_url");
                    if (fb != null && fb.startsWith("http")) web.loadUrl(fb);
                }
            } catch (Exception ignored) { }
            return true;
        }
        openExternal(u);
        return true;
    }

    void openExternal(String u) {
        if (u == null) return;
        try { Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(u)); i.addCategory(Intent.CATEGORY_BROWSABLE); startActivity(i); }
        catch (Exception e) { Toast.makeText(this, "No app can open this link.", Toast.LENGTH_SHORT).show(); }
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        if (req != FILE_REQ || fileCallback == null) { super.onActivityResult(req, res, data); return; }
        fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(res, data));
        fileCallback = null;
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack(); else finish();
    }

    @Override
    protected void onDestroy() {
        if (web != null) { web.stopLoading(); web.setWebChromeClient(null); ((ViewGroup) web.getParent()).removeView(web); web.destroy(); web = null; }
        super.onDestroy();
    }
}
