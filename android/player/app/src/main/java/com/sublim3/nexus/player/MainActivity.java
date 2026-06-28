package com.sublim3.nexus.player;

import android.content.SharedPreferences;
import android.os.Bundle;
import android.view.View;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
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
    private TextView activeRouteLabel;
    private SharedPreferences prefs;
    private String currentRoute = ROUTE_PLAYER;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        setupView = findViewById(R.id.setupView);
        webShell = findViewById(R.id.webShell);
        hostInput = findViewById(R.id.hostInput);
        webView = findViewById(R.id.nexusWebView);
        activeRouteLabel = findViewById(R.id.activeRouteLabel);

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
        webView.setWebViewClient(new WebViewClient());

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);

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
        webView.loadUrl(host + route);
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
