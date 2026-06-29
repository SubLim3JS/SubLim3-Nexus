package com.sublim3.nexus.owner;

import android.content.SharedPreferences;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.webkit.JavascriptInterface;
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

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends AppCompatActivity {
    private static final String PREFS_NAME = "nexus_owner_prefs";
    private static final String PREF_NEXUS_HOST = "nexus_host";
    private static final String DEFAULT_NEXUS_HOST = "http://sublim3-nexus.local:3000";
    private static final String ROUTE_ADMIN = "/admin/";
    private static final String ROUTE_GM = "/gm/";

    private LinearLayout setupView;
    private LinearLayout webShell;
    private EditText hostInput;
    private WebView webView;
    private TextView activeRouteLabel;
    private SharedPreferences prefs;
    private String currentRoute = ROUTE_ADMIN;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final ExecutorService executor = Executors.newSingleThreadExecutor();

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

        webView.addJavascriptInterface(new NexusAndroidBridge(), "NexusAndroid");
        WebView.setWebContentsDebuggingEnabled(true);
    }

    private void configureActions() {
        Button connectButton = findViewById(R.id.connectButton);
        Button adminButton = findViewById(R.id.adminButton);
        Button gmButton = findViewById(R.id.gmButton);
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

        adminButton.setOnClickListener(v -> switchRoute(ROUTE_ADMIN));
        gmButton.setOnClickListener(v -> switchRoute(ROUTE_GM));
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
        activeRouteLabel.setText(route.equals(ROUTE_GM) ? R.string.route_gm : R.string.route_admin);
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

    private String currentHost() {
        String host = prefs.getString(PREF_NEXUS_HOST, "");
        return host == null || host.isBlank() ? DEFAULT_NEXUS_HOST : host;
    }

    private void startNativeSystemUpdate(String token) {
        mainHandler.post(() -> {
            MaintenanceDialog maintenance = showMaintenanceDialog(R.string.update_native_starting);
            executor.execute(() -> runSystemUpdate(token == null ? "" : token, maintenance.statusView, maintenance.progressBar, maintenance.dialog));
        });
    }

    private void startNativeSystemAction(String action, String token) {
        mainHandler.post(() -> {
            int startingMessage = "reboot".equals(action) ? R.string.reboot_native_starting : R.string.shutdown_native_starting;
            MaintenanceDialog maintenance = showMaintenanceDialog(startingMessage);
            executor.execute(() -> runSystemAction(action, token == null ? "" : token, maintenance.statusView, maintenance.progressBar, maintenance.dialog));
        });
    }

    private MaintenanceDialog showMaintenanceDialog(int startingMessage) {
        LinearLayout updateView = new LinearLayout(this);
        updateView.setOrientation(LinearLayout.VERTICAL);
        updateView.setPadding(0, Math.round(12 * getResources().getDisplayMetrics().density), 0, 0);

        int padding = Math.round(24 * getResources().getDisplayMetrics().density);
        ProgressBar progressBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progressBar.setIndeterminate(true);
        LinearLayout.LayoutParams progressParams = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        );
        progressParams.gravity = Gravity.CENTER_HORIZONTAL;
        progressParams.setMargins(padding, 0, padding, 0);
        updateView.addView(progressBar, progressParams);

        TextView statusView = new TextView(this);
        statusView.setPadding(padding, padding / 2, padding, 0);
        statusView.setText(startingMessage);
        updateView.addView(statusView, new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        ));

        AlertDialog dialog = new AlertDialog.Builder(this)
            .setTitle(R.string.update_native_title)
            .setView(updateView)
            .setNegativeButton(R.string.close, null)
            .create();
        dialog.setOnShowListener(listener -> dialog.getButton(AlertDialog.BUTTON_NEGATIVE).setEnabled(false));
        dialog.show();

        return new MaintenanceDialog(statusView, progressBar, dialog);
    }

    private void runSystemUpdate(String token, TextView statusView, ProgressBar progressBar, AlertDialog dialog) {
        long startedAt = System.currentTimeMillis();
        boolean requestStarted = false;
        try {
            postStatus(statusView, getString(R.string.update_native_downloading));
            postJson("/api/v1/system/update", token);
            requestStarted = true;
        } catch (IOException error) {
            requestStarted = true;
        } catch (Exception error) {
            finishNativeUpdate(statusView, progressBar, dialog, getString(R.string.update_native_failed, error.getMessage()), true);
            return;
        }

        postStatus(statusView, getString(requestStarted ? R.string.update_native_reconnecting : R.string.update_native_waiting));
        try {
            String status = waitForCore(startedAt + 120_000);
            finishNativeUpdate(statusView, progressBar, dialog, getString(R.string.update_native_complete, status), false);
            mainHandler.post(() -> webView.reload());
        } catch (Exception error) {
            finishNativeUpdate(statusView, progressBar, dialog, getString(R.string.update_native_unknown, error.getMessage()), true);
        }
    }

    private void runSystemAction(String action, String token, TextView statusView, ProgressBar progressBar, AlertDialog dialog) {
        long startedAt = System.currentTimeMillis();
        boolean isReboot = "reboot".equals(action);
        try {
            postStatus(statusView, getString(isReboot ? R.string.reboot_native_requesting : R.string.shutdown_native_requesting));
            postJson("/api/v1/system/" + action, token);
        } catch (IOException error) {
            // Reboot and shutdown commonly interrupt the active HTTP request.
        } catch (Exception error) {
            finishNativeUpdate(statusView, progressBar, dialog, getString(R.string.system_action_native_failed, error.getMessage()), true);
            return;
        }

        if (!isReboot) {
            finishNativeUpdate(statusView, progressBar, dialog, getString(R.string.shutdown_native_complete), false);
            return;
        }

        postStatus(statusView, getString(R.string.reboot_native_reconnecting));
        try {
            String status = waitForCore(startedAt + 120_000);
            finishNativeUpdate(statusView, progressBar, dialog, getString(R.string.reboot_native_complete, status), false);
            mainHandler.post(() -> webView.reload());
        } catch (Exception error) {
            finishNativeUpdate(statusView, progressBar, dialog, getString(R.string.reboot_native_unknown, error.getMessage()), true);
        }
    }

    private void postJson(String path, String token) throws IOException {
        HttpURLConnection connection = openConnection(path, token);
        connection.setRequestMethod("POST");
        connection.setRequestProperty("Content-Type", "application/json");
        connection.setDoOutput(true);
        connection.getOutputStream().write("{}".getBytes(StandardCharsets.UTF_8));
        int code = connection.getResponseCode();
        if (code < 200 || code >= 300) {
            throw new IllegalStateException(readBody(connection.getErrorStream()));
        }
    }

    private String waitForCore(long deadlineMs) throws Exception {
        Exception lastError = null;
        while (System.currentTimeMillis() < deadlineMs) {
            try {
                HttpURLConnection connection = openConnection("/api/v1/system/status", "");
                connection.setRequestMethod("GET");
                if (connection.getResponseCode() >= 200 && connection.getResponseCode() < 300) {
                    return readBody(connection.getInputStream());
                }
            } catch (Exception error) {
                lastError = error;
            }
            Thread.sleep(1_000);
        }
        throw lastError == null ? new IOException("Nexus Core did not return before the timeout.") : lastError;
    }

    private HttpURLConnection openConnection(String path, String token) throws IOException {
        URL url = new URL(currentHost() + path);
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setConnectTimeout(4_000);
        connection.setReadTimeout(20_000);
        connection.setRequestProperty("Accept", "application/json");
        if (token != null && !token.isBlank()) {
            connection.setRequestProperty("Authorization", "Bearer " + token);
        }
        return connection;
    }

    private String readBody(InputStream stream) throws IOException {
        if (stream == null) return "";
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
            StringBuilder body = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) {
                body.append(line);
            }
            return body.toString();
        }
    }

    private void postStatus(TextView statusView, String message) {
        mainHandler.post(() -> statusView.setText(message));
    }

    private void finishNativeUpdate(TextView statusView, ProgressBar progressBar, AlertDialog dialog, String message, boolean failed) {
        mainHandler.post(() -> {
            progressBar.setVisibility(View.GONE);
            statusView.setText(message);
            dialog.getButton(AlertDialog.BUTTON_NEGATIVE).setEnabled(true);
            Toast.makeText(this, failed ? R.string.update_native_failed_toast : R.string.update_native_complete_toast, Toast.LENGTH_LONG).show();
        });
    }

    @Override
    protected void onDestroy() {
        executor.shutdownNow();
        super.onDestroy();
    }

    private class NexusAndroidBridge {
        @JavascriptInterface
        public String getAppInfo() {
            try {
                android.content.pm.PackageInfo info = getPackageManager().getPackageInfo(getPackageName(), 0);
                return "{\"name\":\"SubLim3 Nexus Owner\",\"packageName\":\"" + getPackageName() + "\",\"versionName\":\"" + info.versionName + "\",\"versionCode\":" + info.versionCode + "}";
            } catch (Exception error) {
                return "{\"name\":\"SubLim3 Nexus Owner\",\"packageName\":\"" + getPackageName() + "\",\"versionName\":\"unknown\",\"versionCode\":0}";
            }
        }

        @JavascriptInterface
        public void startSystemUpdate(String token) {
            MainActivity.this.startNativeSystemUpdate(token);
        }

        @JavascriptInterface
        public void startSystemAction(String action, String token) {
            if (!"reboot".equals(action) && !"shutdown".equals(action)) return;
            MainActivity.this.startNativeSystemAction(action, token);
        }
    }

    private static class MaintenanceDialog {
        final TextView statusView;
        final ProgressBar progressBar;
        final AlertDialog dialog;

        MaintenanceDialog(TextView statusView, ProgressBar progressBar, AlertDialog dialog) {
            this.statusView = statusView;
            this.progressBar = progressBar;
            this.dialog = dialog;
        }
    }
}
