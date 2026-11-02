package org.endo.floot;

import android.Manifest;
import android.app.Activity;
import android.app.KeyguardManager;
import android.app.role.RoleManager;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.LocalSocket;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.widget.EditText;
import android.widget.Toast;
import android.widget.LinearLayout;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewClientCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import org.json.JSONObject;
import java.util.Set;
import java.util.concurrent.Executors;
import java.util.concurrent.ExecutorService;
import java.nio.charset.StandardCharsets;

public final class MainActivity extends Activity {
    private static final String ORIGIN = "https://appassets.androidplatform.net";
    private WebView web;
    private String assistantInvocation;
    private PermissionRequest microphone;
    private Connection active;
    private String selectedOrigin = ORIGIN;

    private final class Connection {
        final String id;
        final JavaScriptReplyProxy reply;
        final ExecutorService writer = Executors.newSingleThreadExecutor();
        volatile LocalSocket socket;
        volatile boolean closed;
        int queuedBytes;
        final java.util.concurrent.Semaphore incoming = new java.util.concurrent.Semaphore(Netstrings.MAX_BYTES);
        Connection(String id, JavaScriptReplyProxy reply) { this.id = id; this.reply = reply; }
        void emit(String type, String data) {
            int bytes = data.getBytes(StandardCharsets.UTF_8).length;
            if (!incoming.tryAcquire(bytes)) {
                close();
                runOnUiThread(() -> {
                    if (active != this) return;
                    try { reply.postMessage(new JSONObject().put("id", id).put("type", "closed").put("data", "Local receive buffer exceeded").toString()); }
                    catch (Exception ignored) {}
                });
                return;
            }
            runOnUiThread(() -> {
                try {
                    if (active != this) return;
                    reply.postMessage(new JSONObject().put("id", id).put("type", type).put("data", data).toString());
                } catch (Exception ignored) { close(); }
                finally { incoming.release(bytes); }
            });
        }
        void open() {
            new Thread(() -> {
                try {
                    LocalSocket connected = LocalDaemon.connect(getApplicationContext());
                    synchronized (this) {
                        if (closed) { connected.close(); return; }
                        socket = connected;
                    }
                    emit("ready", "");
                    while (!closed) emit("message", Netstrings.read(connected.getInputStream()));
                } catch (Exception error) {
                    if (!closed) {
                        Diagnostics.record(MainActivity.this, "daemon connection", android.util.Log.getStackTraceString(error));
                        emit("closed", "Local Endo connection closed. Reconnecting preserves your objects.");
                    }
                } finally { close(); }
            }, "floot-captp").start();
        }
        synchronized void send(String data) {
            if (closed || socket == null) return;
            int bytes = data.getBytes(StandardCharsets.UTF_8).length;
            if (bytes > Netstrings.MAX_BYTES || queuedBytes + bytes > Netstrings.MAX_BYTES) {
                emit("closed", "Local transport buffer exceeded; reconnect to resynchronize.");
                close();
                return;
            }
            queuedBytes += bytes;
            writer.execute(() -> {
                try { Netstrings.write(socket.getOutputStream(), data); }
                catch (Exception error) { emit("closed", "Local transport write failed."); close(); }
                finally { synchronized (this) { queuedBytes -= bytes; } }
            });
        }
        synchronized void close() {
            if (closed) return;
            closed = true;
            try { if (socket != null) socket.close(); } catch (Exception ignored) {}
            writer.shutdownNow();
        }
    }

    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        assistantInvocation = saved != null ? saved.getString("assistantInvocation")
            : assistantInvocationFrom(getIntent());
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(getColor(R.color.surface));
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets;
        });
        android.widget.Toolbar toolbar = new android.widget.Toolbar(this);
        toolbar.setTitle("Floot");
        toolbar.setSubtitle(getPreferences(MODE_PRIVATE).getBoolean("remote", false) ? "Remote Endo" : "This phone");
        toolbar.setTitleTextColor(getColor(R.color.foreground));
        toolbar.setSubtitleTextColor(getColor(R.color.secondary));
        toolbar.getMenu().add("Connection").setOnMenuItemClickListener(item -> { showConnection(toolbar); return true; });
        toolbar.getMenu().add("Use as assistant").setOnMenuItemClickListener(item -> {
            requestAssistant();
            return true;
        });
        toolbar.getMenu().add("Diagnostics").setOnMenuItemClickListener(item -> { showDiagnostics(); return true; });
        root.addView(toolbar, new LinearLayout.LayoutParams(-1, -2));
        if ((getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0)
            WebView.setWebContentsDebuggingEnabled(true);
        web = new WebView(this);
        web.setBackgroundColor(getColor(R.color.surface));
        root.addView(web, new LinearLayout.LayoutParams(-1, 0, 1));
        setContentView(root);
        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setDomStorageEnabled(true);
        web.getSettings().setAllowFileAccess(false);
        web.getSettings().setAllowContentAccess(false);
        web.getSettings().setMediaPlaybackRequiresUserGesture(true);
        WebViewAssetLoader assets = new WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this)).build();
        web.setWebViewClient(new WebViewClientCompat() {
            @Override public void onPageFinished(WebView view, String url) { deliverAssistantInvocation(); }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, androidx.webkit.WebResourceErrorCompat error) {
                Diagnostics.record(MainActivity.this, "web load", error.getErrorCode() + ": " + error.getDescription());
            }
            @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
                Diagnostics.record(MainActivity.this, "web HTTP", "status " + response.getStatusCode());
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return assets.shouldInterceptRequest(request.getUrl());
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (ConnectionUrl.matchesOrigin(uri.toString(), selectedOrigin)) return false;
                if (request.isForMainFrame() && ("https".equals(uri.getScheme()) || "http".equals(uri.getScheme()))) {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                }
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onConsoleMessage(android.webkit.ConsoleMessage message) {
                if (message.messageLevel() == android.webkit.ConsoleMessage.MessageLevel.ERROR
                    || message.messageLevel() == android.webkit.ConsoleMessage.MessageLevel.WARNING) {
                    Diagnostics.record(MainActivity.this, "web " + message.messageLevel(), message.message() + " at " + message.sourceId() + ":" + message.lineNumber());
                }
                return true;
            }
            @Override public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> {
                    boolean audioOnly = request.getResources().length == 1
                        && PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(request.getResources()[0]);
                    if (!ConnectionUrl.matchesOrigin(request.getOrigin().toString(), selectedOrigin) || !audioOnly
                        || getSystemService(KeyguardManager.class).isDeviceLocked()) { request.deny(); return; }
                    if (microphone != null) microphone.deny();
                    microphone = request;
                    if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                        microphone.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE}); microphone = null;
                    } else requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, 1);
                });
            }
            @Override public void onPermissionRequestCanceled(PermissionRequest request) {
                if (microphone == request) microphone = null;
            }
        });
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            Toast.makeText(this, "Update Android System WebView to run Floot", Toast.LENGTH_LONG).show(); return;
        }
        // This bridge can only acknowledge a pending launch; it grants no Endo powers.
        WebViewCompat.addWebMessageListener(web, "AndroidAssistant", Set.of("*"),
            (view, message, origin, mainFrame, reply) -> {
                if (!mainFrame || !ConnectionUrl.matchesOrigin(origin.toString(), selectedOrigin)) return;
                try {
                    JSONObject result = new JSONObject(message.getData());
                    if (assistantInvocation == null || !assistantInvocation.equals(result.getString("id"))) return;
                    assistantInvocation = null;
                    getIntent().removeExtra("assistantInvocation");
                    getIntent().setAction(Intent.ACTION_MAIN);
                    String error = result.optString("error");
                    Diagnostics.record(this, "assistant launch", error.isEmpty() ? "Launch accepted by Floot UI" : error);
                    if (!error.isEmpty()) Toast.makeText(this, error, Toast.LENGTH_LONG).show();
                } catch (Exception error) { Diagnostics.record(this, "assistant launch", error.toString()); }
            });
        WebViewCompat.addWebMessageListener(web, "AndroidEndo", Set.of(ORIGIN),
            (view, message, origin, mainFrame, reply) -> {
                if (!mainFrame || !ORIGIN.equals(selectedOrigin) || !ConnectionUrl.matchesOrigin(origin.toString(), ORIGIN)) return;
                try {
                    JSONObject event = new JSONObject(message.getData());
                    String id = event.getString("id");
                    switch (event.getString("type")) {
                        case "open":
                            if (active != null) active.close();
                            active = new Connection(id, reply); active.open(); break;
                        case "message":
                            if (active != null && active.id.equals(id)) active.send(event.getString("data")); break;
                        case "close":
                            if (active != null && active.id.equals(id)) active.close(); break;
                        default: break;
                    }
                } catch (Exception ignored) { if (active != null) active.close(); }
            });
        String start = ORIGIN + "/assets/chat/index.html#android=1";
        if (getPreferences(MODE_PRIVATE).getBoolean("remote", false)) {
            String value = getPreferences(MODE_PRIVATE).getString("remoteUrl", "");
            try { selectedOrigin = ConnectionUrl.origin(value); start = value; }
            catch (IllegalArgumentException ignored) { selectedOrigin = ORIGIN; }
        }
        web.loadUrl(start);
    }
    private String assistantInvocationFrom(Intent intent) {
        String id = AssistantInvocation.take(intent.getStringExtra("assistantInvocation"));
        // Exported ACTION_ASSIST intents (Android 10/11 fallback) are forgeable.
        // They open the UI only; automatic recording requires the protected
        // VoiceInteractionSession's single-use handoff.
        return id;
    }
    private void deliverAssistantInvocation() {
        if (web == null || assistantInvocation == null || !hasWindowFocus()) return;
        if (!ConnectionUrl.matchesOrigin(web.getUrl(), selectedOrigin)) return;
        // The assistant gesture authorizes immediate recording and spoken replies.
        web.getSettings().setMediaPlaybackRequiresUserGesture(false);
        String request = "{id:" + JSONObject.quote(assistantInvocation) + "}";
        web.evaluateJavascript("window.endoAssistantInvocation=" + request
            + ";window.dispatchEvent(new Event('endo-assistant'));", null);
    }
    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        String id = assistantInvocationFrom(intent);
        if (id != null) assistantInvocation = id;
        deliverAssistantInvocation();
    }
    @Override public void onWindowFocusChanged(boolean focused) {
        super.onWindowFocusChanged(focused);
        if (focused) deliverAssistantInvocation();
    }
    @Override protected void onSaveInstanceState(Bundle state) {
        state.putString("assistantInvocation", assistantInvocation);
        super.onSaveInstanceState(state);
    }
    private boolean isAssistantSelected() {
        RoleManager roles = getSystemService(RoleManager.class);
        return roles != null && roles.isRoleAvailable(RoleManager.ROLE_ASSISTANT)
            && roles.isRoleHeld(RoleManager.ROLE_ASSISTANT);
    }
    private void requestAssistant() {
        if (isAssistantSelected()) { showAssistantResult(); return; }
        // ASSISTANT can be available but not requestable via createRequestRoleIntent.
        // Samsung rejects that intent immediately; use the system settings picker.
        Diagnostics.record(this, "assistant", "Opening default assistant settings");
        openAssistantSettings();
    }
    private void openAssistantSettings() {
        try {
            startActivityForResult(new Intent(android.provider.Settings.ACTION_VOICE_INPUT_SETTINGS), 4);
        } catch (android.content.ActivityNotFoundException error) {
            try {
                startActivityForResult(new Intent(android.provider.Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS), 4);
            } catch (android.content.ActivityNotFoundException unavailable) {
                Toast.makeText(this, "Open Settings → Apps → Default apps → Digital assistant app", Toast.LENGTH_LONG).show();
            }
        }
    }
    private void showAssistantResult() {
        boolean selected = isAssistantSelected();
        Diagnostics.record(this, "assistant", "Floot selected: " + selected);
        android.app.AlertDialog.Builder dialog = new android.app.AlertDialog.Builder(this)
            .setTitle(selected ? "Floot is your assistant" : "Floot was not selected")
            .setMessage(selected
                ? "Your assistant shortcut opens Floot. On Samsung, set Settings → Advanced features → Side button → Long press to Digital assistant. On Android 12 or newer, the shortcut starts a new General Assistant session with Fae Codex 5.6 Sol and listens immediately. On older Android versions, tap the mic in Floot."
                : "Android kept your current assistant. Choose Floot in Settings → Apps → Default apps → Digital assistant app.")
            .setNegativeButton("Close", null);
        if (!selected) dialog.setPositiveButton("Open assistant settings", (d, which) -> openAssistantSettings());
        dialog.show();
    }
    private void showConnection(android.widget.Toolbar toolbar) {
        EditText remote = new EditText(this);
        remote.setSingleLine(true);
        remote.setHint("https://…#gateway=…&agent=…");
        remote.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_URI);
        remote.setText(getPreferences(MODE_PRIVATE).getString("remoteUrl", ""));
        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        int padding = (int) (24 * getResources().getDisplayMetrics().density);
        content.setPadding(padding, padding / 2, padding, padding / 2);
        android.widget.TextView hint = new android.widget.TextView(this);
        hint.setText("Use this phone’s Endo, or paste a remote Endo web URL.");
        content.addView(hint); content.addView(remote);
        android.app.AlertDialog dialog = new android.app.AlertDialog.Builder(this)
            .setTitle("Connection").setView(content).setNegativeButton("Cancel", null)
            .setNeutralButton("This phone", (d, which) -> {
                if (active != null) { active.close(); active = null; }
                selectedOrigin = ORIGIN;
                getPreferences(MODE_PRIVATE).edit().putBoolean("remote", false).apply();
                toolbar.setSubtitle("This phone");
                web.loadUrl(ORIGIN + "/assets/chat/index.html#android=1");
            }).setPositiveButton("Connect", null).create();
        dialog.setOnShowListener(d -> dialog.getButton(android.app.AlertDialog.BUTTON_POSITIVE).setOnClickListener(view -> {
            String value = remote.getText().toString().trim();
            try {
                selectedOrigin = ConnectionUrl.origin(value);
                if (active != null) { active.close(); active = null; }
                getPreferences(MODE_PRIVATE).edit().putString("remoteUrl", value).putBoolean("remote", true).apply();
                toolbar.setSubtitle("Remote Endo");
                web.loadUrl(value); dialog.dismiss();
            } catch (IllegalArgumentException error) { remote.setError("Enter an HTTPS Endo web URL"); }
        }));
        dialog.show();
    }
    private void showDiagnostics() {
        String report = Diagnostics.preview(this);
        android.widget.TextView text = new android.widget.TextView(this);
        text.setText(report); text.setTextIsSelectable(true); text.setTextSize(12);
        int padding = (int) (16 * getResources().getDisplayMetrics().density);
        text.setPadding(padding, padding, padding, padding);
        text.setTypeface(android.graphics.Typeface.MONOSPACE);
        android.widget.ScrollView scroll = new android.widget.ScrollView(this); scroll.addView(text);
        new android.app.AlertDialog.Builder(this).setTitle("Diagnostics")
            .setView(scroll).setNegativeButton("Close", null)
            .setPositiveButton("Save logs…", (dialog, which) -> {
                Intent save = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                save.addCategory(Intent.CATEGORY_OPENABLE); save.setType("text/plain");
                save.putExtra(Intent.EXTRA_TITLE, "floot-diagnostics.txt");
                startActivityForResult(save, 3);
            }).show();
    }
    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request == 4) {
            Diagnostics.record(this, "assistant", "Selection returned: " + result);
            // Re-read the actual role; RESULT_OK alone is not proof of selection.
            showAssistantResult();
            return;
        }
        if (request != 3) return;
        if (result != RESULT_OK || data == null || data.getData() == null) return;
        // Read after the picker returns, including after Activity recreation.
        // Reports can exceed Binder's saved-state limit; never put one in a Bundle.
        String report = Diagnostics.report(this);
        try (java.io.OutputStream out = getContentResolver().openOutputStream(data.getData())) {
            if (out == null) throw new java.io.IOException("No output stream");
            out.write(report.getBytes(StandardCharsets.UTF_8));
            Toast.makeText(this, "Logs saved", Toast.LENGTH_SHORT).show();
        } catch (java.io.IOException error) {
            Diagnostics.record(this, "export", error.toString());
            Toast.makeText(this, "Could not save logs", Toast.LENGTH_LONG).show();
        }
    }
    @Override public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(code, permissions, results);
        if (code == 1 && microphone != null) {
            if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED && hasWindowFocus()
                && ConnectionUrl.matchesOrigin(microphone.getOrigin().toString(), selectedOrigin))
                microphone.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
            else microphone.deny();
            microphone = null;
        }
    }
    @Override protected void onPause() {
        if (microphone != null) { microphone.deny(); microphone = null; }
        web.evaluateJavascript("window.dispatchEvent(new Event('endo-suspend'))", null);
        Diagnostics.record(this, "lifecycle", "Activity backgrounded; local audio suspended");
        web.onPause();
        super.onPause();
    }
    @Override protected void onResume() {
        super.onResume();
        if (web != null) {
            web.onResume();
            web.evaluateJavascript("window.dispatchEvent(new Event('endo-resume'))", null);
            deliverAssistantInvocation();
        }
    }
    @Override protected void onDestroy() {
        if (active != null) active.close();
        web.destroy();
        super.onDestroy();
    }
}
