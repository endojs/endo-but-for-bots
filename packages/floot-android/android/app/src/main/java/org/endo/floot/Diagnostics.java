package org.endo.floot;

import android.content.Context;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.time.Instant;

/** App-private, bounded logs. Export is always an explicit user action. */
final class Diagnostics {
    static final int LIMIT = 256 * 1024;
    static String redact(String text) {
        return text.replaceAll("(?i)(https?://[^\\s#]+)#[^\\s]+", "$1#[redacted]")
            .replaceAll("endo://[^\\s\"<>]+", "endo://[redacted]")
            .replaceAll("(?i)(bearer\\s+|(?:agent|token|password)=)[^\\s&]+", "$1[redacted]");
    }
    static void record(Context context, String source, String message) {
        String name = android.app.Application.getProcessName().endsWith(":voice") ? "voice" : "app";
        recordFile(new File(context.getNoBackupFilesDir(), "diagnostics"), name, source, message);
    }
    static synchronized void recordFile(File directory, String name, String source, String message) {
        try {
            if (!directory.isDirectory() && !directory.mkdirs()) return;
            File file = new File(directory, name + ".log");
            String bounded = message.length() > 8192 ? message.substring(0, 8192) + " [truncated]" : message;
            byte[] bytes = (Instant.now() + " [" + source + "] " + redact(bounded) + "\n").getBytes(StandardCharsets.UTF_8);
            if (file.length() + bytes.length > LIMIT) {
                File previous = new File(directory, name + "-previous.log");
                if (previous.exists() && !previous.delete()) return;
                if (!file.renameTo(previous)) return;
            }
            try (FileOutputStream out = new FileOutputStream(file, true)) { out.write(bytes); }
        } catch (IOException ignored) { /* Logging must not crash the app. */ }
    }
    /** Drain throughout background execution, bounding even a line without a newline. */
    static void drain(File directory, InputStream stream) throws IOException {
        try (Reader reader = new InputStreamReader(stream, StandardCharsets.UTF_8)) {
            char[] buffer = new char[4096];
            StringBuilder line = new StringBuilder();
            boolean truncated = false;
            int count;
            while ((count = reader.read(buffer)) != -1) {
                for (int i = 0; i < count; i++) {
                    char ch = buffer[i];
                    if (ch == '\n') {
                        if (!truncated) recordFile(directory, "daemon", "Endo", line.toString());
                        line.setLength(0); truncated = false;
                    } else if (!truncated) {
                        line.append(ch);
                        if (line.length() == 8192) {
                            recordFile(directory, "daemon", "Endo", line + " [truncated]");
                            line.setLength(0); truncated = true;
                        }
                    }
                }
            }
            if (line.length() > 0) recordFile(directory, "daemon", "Endo", line.toString());
        }
    }
    private static String tail(File file, int limit) {
        if (!file.isFile()) return "(no log recorded)\n";
        try (RandomAccessFile in = new RandomAccessFile(file, "r")) {
            long length = in.length();
            long start = Math.max(0, length - limit);
            in.seek(start);
            byte[] bytes = new byte[(int) (length - start)];
            in.readFully(bytes);
            return (start > 0 ? "[older output truncated]\n" : "") + redact(new String(bytes, StandardCharsets.UTF_8));
        } catch (IOException error) { return "Could not read log: " + error.getClass().getSimpleName() + "\n"; }
    }
    static String report(Context context) { return report(context, LIMIT); }
    static String preview(Context context) { return report(context, 8192); }
    private static synchronized String report(Context context, int limit) {
        File directory = new File(context.getNoBackupFilesDir(), "diagnostics");
        StringBuilder report = new StringBuilder("Floot Android diagnostics\nGenerated: " + Instant.now()
            + "\nAndroid API: " + android.os.Build.VERSION.SDK_INT + "\n");
        report.append("Microphone permission: ").append(context.checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) == android.content.pm.PackageManager.PERMISSION_GRANTED)
            .append("\nAudio settings permission: ").append(context.checkSelfPermission(android.Manifest.permission.MODIFY_AUDIO_SETTINGS) == android.content.pm.PackageManager.PERMISSION_GRANTED).append("\n");
        android.app.role.RoleManager roles = context.getSystemService(android.app.role.RoleManager.class);
        report.append("Floot assistant selected: ").append(roles != null && roles.isRoleAvailable(android.app.role.RoleManager.ROLE_ASSISTANT)
            && roles.isRoleHeld(android.app.role.RoleManager.ROLE_ASSISTANT)).append("\n");
        android.content.pm.PackageInfo webView = android.webkit.WebView.getCurrentWebViewPackage();
        if (webView != null) report.append("WebView: ").append(webView.packageName).append(" ").append(webView.versionName).append("\n");
        if (limit < LIMIT) report.append("Preview: recent output per log. Save logs for all retained output.\n");
        return report.append(reportFiles(directory, limit)).toString();
    }
    static String reportFiles(File directory, int limit) {
        StringBuilder report = new StringBuilder();
        for (String name : new String[]{"app", "voice", "daemon"}) {
            report.append("\n").append(name).append(" previous\n").append(tail(new File(directory, name + "-previous.log"), limit));
            report.append("\n").append(name).append(" current\n").append(tail(new File(directory, name + ".log"), limit));
        }
        return report.toString();
    }
    private Diagnostics() {}
}
