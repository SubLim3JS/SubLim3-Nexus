package com.sublim3.nexus.player;

import android.content.SharedPreferences;
import android.os.Bundle;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
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

    private void configureWebView() {
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                pageRefreshProgress.setVisibility(View.GONE);
                super.onPageFinished(view, url);
            }
        });

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
}
