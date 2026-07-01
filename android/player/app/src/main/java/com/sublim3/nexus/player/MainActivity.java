package com.sublim3.nexus.player;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.WindowInsets;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import androidx.activity.OnBackPressedCallback;
import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;

public class MainActivity extends AppCompatActivity {
    private static final String PREFS_NAME = "nexus_player_prefs";
    private static final String PREF_NEXUS_HOST = "nexus_host";
    private static final String DEFAULT_NEXUS_HOST = "http://sublim3-nexus.local:3000";
    private static final String ROUTE_PLAYER = "/player/";

    private LinearLayout setupView;
    private LinearLayout webShell;
    private EditText hostInput;
    private WebView webView;
    private ProgressBar pageRefreshProgress;
    private TextView activeRouteLabel;
    private SharedPreferences prefs;
    private String currentRoute = ROUTE_PLAYER;
    private float touchStartY;
    private boolean pullRefreshTriggered;
    private int pullRefreshThreshold;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);
        configureSystemInsets();

        prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        setupView = findViewById(R.id.setupView);
        webShell = findViewById(R.id.webShell);
        hostInput = findViewById(R.id.hostInput);
        webView = findViewById(R.id.nexusWebView);
        pageRefreshProgress = findViewById(R.id.pageRefreshProgress);
        activeRouteLabel = findViewById(R.id.activeRouteLabel);
        pullRefreshThreshold = ViewConfiguration.get(this).getScaledTouchSlop() * 8;

        configureWebView();
        configureActions();
        configureBackButton();

        String savedHost = prefs.getString(PREF_NEXUS_HOST, "");
        if (savedHost == null || savedHost.isBlank()) {
            showSetup();
        } else {
            openNexus(savedHost, currentRoute);
        }
    }

    private void configureSystemInsets() {
        View root = findViewById(R.id.main);
        View topBar = findViewById(R.id.topBar);
        int topBarPaddingLeft = topBar.getPaddingLeft();
        int topBarPaddingTop = topBar.getPaddingTop();
        int topBarPaddingRight = topBar.getPaddingRight();
        int topBarPaddingBottom = topBar.getPaddingBottom();
        getWindow().setStatusBarColor(getColor(R.color.nexus_surface));
        getWindow().setNavigationBarColor(getColor(R.color.nexus_primary_dark));
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            int statusBarTop = insets.getSystemWindowInsetTop();
            int navigationBarBottom = insets.getSystemWindowInsetBottom();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                Insets statusBars = insets.getInsets(WindowInsets.Type.statusBars());
                Insets navigationBars = insets.getInsets(WindowInsets.Type.navigationBars());
                statusBarTop = statusBars.top;
                navigationBarBottom = navigationBars.bottom;
            }
            topBar.setPadding(
                topBarPaddingLeft,
                topBarPaddingTop + statusBarTop,
                topBarPaddingRight,
                topBarPaddingBottom
            );
            view.setPadding(0, 0, 0, navigationBarBottom);
            return insets;
        });
        root.requestApplyInsets();
    }

    private void configureWebView() {
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (request != null && shouldOpenExternally(request.getUrl())) {
                    openExternalDownload(request.getUrl().toString());
                    return true;
                }
                return super.shouldOverrideUrlLoading(view, request);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                pageRefreshProgress.setVisibility(View.GONE);
                super.onPageFinished(view, url);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request != null && request.isForMainFrame()) {
                    pageRefreshProgress.setVisibility(View.GONE);
                    showConnectionHelpPage();
                    return;
                }
                super.onReceivedError(view, request, error);
            }
        });
        webView.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) -> openExternalDownload(url));

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);

        webView.setOnTouchListener((view, event) -> {
            if (event.getAction() == MotionEvent.ACTION_DOWN) {
                touchStartY = event.getY();
                pullRefreshTriggered = false;
            } else if (event.getAction() == MotionEvent.ACTION_MOVE) {
                float pullDistance = event.getY() - touchStartY;
                if (!pullRefreshTriggered && webView.getScrollY() == 0 && pullDistance > pullRefreshThreshold) {
                    pullRefreshTriggered = true;
                    refreshCurrentPage();
                }
            } else if (event.getAction() == MotionEvent.ACTION_UP || event.getAction() == MotionEvent.ACTION_CANCEL) {
                pullRefreshTriggered = false;
            }
            return false;
        });
        WebView.setWebContentsDebuggingEnabled(true);
    }

    private void configureActions() {
        Button connectButton = findViewById(R.id.connectButton);
        Button reloadButton = findViewById(R.id.reloadButton);
        Button changeHostButton = findViewById(R.id.changeHostButton);
        Button setupHelpButton = findViewById(R.id.setupHelpButton);
        Button helpButton = findViewById(R.id.helpButton);

        connectButton.setOnClickListener(v -> {
            String host = normalizeHost(hostInput.getText().toString());
            if (host.isBlank()) {
                Toast.makeText(this, R.string.host_required, Toast.LENGTH_SHORT).show();
                return;
            }

            prefs.edit().putString(PREF_NEXUS_HOST, host).apply();
            openNexus(host, currentRoute);
        });

        reloadButton.setOnClickListener(v -> webView.reload());
        changeHostButton.setOnClickListener(v -> showSetup());
        setupHelpButton.setOnClickListener(v -> showConnectionHelpDialog(false));
        helpButton.setOnClickListener(v -> showConnectionHelpDialog(true));
    }

    private void configureBackButton() {
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (webView.getVisibility() == View.VISIBLE && webView.canGoBack()) {
                    webView.goBack();
                } else {
                    setEnabled(false);
                    getOnBackPressedDispatcher().onBackPressed();
                }
            }
        });
    }

    private void showSetup() {
        String savedHost = prefs.getString(PREF_NEXUS_HOST, "");
        if (savedHost != null && !savedHost.isBlank()) {
            hostInput.setText(savedHost);
        } else {
            hostInput.setText(DEFAULT_NEXUS_HOST);
            hostInput.setSelection(hostInput.getText().length());
        }

        setupView.setVisibility(View.VISIBLE);
        webShell.setVisibility(View.GONE);
    }

    private void openNexus(String host, String route) {
        currentRoute = route;
        setupView.setVisibility(View.GONE);
        webShell.setVisibility(View.VISIBLE);
        activeRouteLabel.setText(R.string.route_player);
        pageRefreshProgress.setVisibility(View.VISIBLE);
        webView.loadUrl(host + route);
    }

    private void refreshCurrentPage() {
        pageRefreshProgress.setVisibility(View.VISIBLE);
        Toast.makeText(this, R.string.refreshing, Toast.LENGTH_SHORT).show();
        webView.reload();
    }

    private void showConnectionHelpPage() {
        String html = "<!doctype html><html><head><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
            + "<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f121c;color:#f8fafc;font-family:system-ui,-apple-system,Segoe UI,sans-serif;text-align:center;padding:28px;box-sizing:border-box}"
            + ".card{max-width:420px;border:1px solid rgba(148,163,184,.28);border-radius:22px;background:linear-gradient(145deg,rgba(24,28,42,.96),rgba(15,18,28,.96));padding:28px;box-shadow:0 24px 70px rgba(0,0,0,.35)}"
            + "h1{font-size:28px;line-height:1.08;margin:0 0 14px}p,ol{color:#aeb3c2;font-size:15px;line-height:1.5;margin:0 0 18px}ol{text-align:left;padding-left:22px}.hint{color:#39ff14;font-weight:700}</style></head>"
            + "<body><main class=\"card\"><h1>" + getString(R.string.connection_error_title) + "</h1>"
            + "<p>" + getString(R.string.connection_error_help) + "</p>"
            + "<ol><li>Check that Nexus is powered on.</li><li>Connect to the Nexus WiFi / Wi-Fi Direct network.</li><li>For Local/Recovery WiFi, use http://10.10.10.1:3000.</li><li>For Home WiFi, use the same router network as Nexus.</li></ol>"
            + "<p class=\"hint\">" + getString(R.string.connection_error_retry) + "</p></main></body></html>";
        webView.loadDataWithBaseURL(currentHost(), html, "text/html", "UTF-8", null);
    }

    private void showConnectionHelpDialog(boolean canRetry) {
        AlertDialog.Builder builder = new AlertDialog.Builder(this)
            .setTitle(R.string.connection_help_title)
            .setMessage(R.string.connection_help_message)
            .setNegativeButton(android.R.string.cancel, null)
            .setNeutralButton(R.string.change, (dialog, which) -> showSetup());
        if (canRetry) {
            builder.setPositiveButton(R.string.try_again, (dialog, which) -> refreshCurrentPage());
        }
        AlertDialog dialog = builder.show();
        styleDialogButtons(dialog);
    }

    private void styleDialogButtons(AlertDialog dialog) {
        int primary = Color.parseColor("#39FF14");
        int secondary = Color.parseColor("#F8FAFC");
        Button positive = dialog.getButton(AlertDialog.BUTTON_POSITIVE);
        Button negative = dialog.getButton(AlertDialog.BUTTON_NEGATIVE);
        Button neutral = dialog.getButton(AlertDialog.BUTTON_NEUTRAL);
        if (positive != null) positive.setTextColor(primary);
        if (negative != null) negative.setTextColor(secondary);
        if (neutral != null) neutral.setTextColor(primary);
    }

    private void switchRoute(String route) {
        String host = prefs.getString(PREF_NEXUS_HOST, "");
        if (host == null || host.isBlank()) {
            showSetup();
        } else {
            openNexus(host, route);
        }
    }

    private String normalizeHost(String value) {
        String trimmed = value == null ? "" : value.trim();
        while (trimmed.endsWith("/")) {
            trimmed = trimmed.substring(0, trimmed.length() - 1);
        }

        if (trimmed.isBlank()) {
            return "";
        }

        if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
            return trimmed;
        }

        return "http://" + trimmed;
    }

    private boolean shouldOpenExternally(Uri uri) {
        if (uri == null) return false;
        String url = uri.toString().toLowerCase();
        return url.endsWith(".apk") || url.contains("/releases/latest/download/") || url.contains("/releases/download/");
    }

    private void openExternalDownload(String url) {
        if (url == null || url.isBlank()) return;
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
        intent.addCategory(Intent.CATEGORY_BROWSABLE);
        try {
            startActivity(intent);
            Toast.makeText(this, R.string.download_opened, Toast.LENGTH_SHORT).show();
        } catch (ActivityNotFoundException error) {
            Toast.makeText(this, R.string.download_unavailable, Toast.LENGTH_LONG).show();
        }
    }

    private String currentHost() {
        String host = prefs.getString(PREF_NEXUS_HOST, "");
        return host == null || host.isBlank() ? DEFAULT_NEXUS_HOST : host;
    }
}
