package org.endo.floot;

import android.content.Context;
import android.net.LocalSocket;
import android.net.LocalSocketAddress;
import java.io.File;
import java.io.IOException;

/** One app-private Endo identity and store. UI reconnection never resets it. */
final class LocalDaemon {
    private static Process process;
    static synchronized LocalSocket connect(Context context) throws IOException, InterruptedException {
        File state = new File(context.getNoBackupFilesDir(), "endo");
        File cache = new File(context.getCacheDir(), "endo");
        if (!state.isDirectory() && !state.mkdirs()) throw new IOException("Cannot create Endo state");
        if (!cache.isDirectory() && !cache.mkdirs()) throw new IOException("Cannot create Endo cache");
        File socket = new File(state, "captp.sock");
        // Android permits executing packaged native code from nativeLibraryDir.
        // Never extract executable code into the writable data directory.
        File binary = new File(context.getApplicationInfo().nativeLibraryDir, "libendor.so");
        if (!binary.isFile()) throw new IOException("Packaged Endo runtime is missing");
        // An Android UI process can die while its daemon remains alive.
        LocalSocket existing = new LocalSocket();
        try {
            existing.connect(new LocalSocketAddress(socket.getAbsolutePath(), LocalSocketAddress.Namespace.FILESYSTEM));
            return existing;
        } catch (IOException ignored) { existing.close(); }
        if (process == null || !process.isAlive()) {
            ProcessBuilder builder = new ProcessBuilder(binary.getAbsolutePath(), "daemon");
            builder.directory(state);
            builder.environment().put("HOME", state.getAbsolutePath());
            builder.environment().put("TMPDIR", cache.getAbsolutePath());
            builder.environment().put("ENDO_STATE_PATH", state.getAbsolutePath());
            builder.environment().put("ENDO_EPHEMERAL_STATE_PATH", state.getAbsolutePath());
            builder.environment().put("ENDO_CACHE_PATH", cache.getAbsolutePath());
            builder.environment().put("ENDO_SOCK_PATH", socket.getAbsolutePath());
            builder.environment().put("ENDO_DEFAULT_PLATFORM", "shared");
            builder.redirectErrorStream(true);
            process = builder.start();
            Process running = process;
            // The reader belongs to the application, not the Activity. It continues
            // recording while the UI is paused or recreated. Android may terminate
            // the whole app; the next launch reopens the same durable Endo store.
            new Thread(() -> {
                try {
                    Diagnostics.drain(new File(context.getNoBackupFilesDir(), "diagnostics"), running.getInputStream());
                    Diagnostics.record(context, "daemon", "Endo exited with status " + running.waitFor());
                } catch (IOException | InterruptedException error) {
                    Diagnostics.record(context, "daemon", error.toString());
                    if (error instanceof InterruptedException) Thread.currentThread().interrupt();
                }
            }, "floot-daemon-log").start();
        }
        IOException failure = new IOException("Endo did not become ready");
        for (int attempt = 0; attempt < 100; attempt++) {
            LocalSocket connection = new LocalSocket();
            try {
                connection.connect(new LocalSocketAddress(socket.getAbsolutePath(), LocalSocketAddress.Namespace.FILESYSTEM));
                return connection;
            } catch (IOException error) {
                failure = error;
                connection.close();
                if (!process.isAlive()) throw new IOException("Endo exited; inspect the app's private daemon log", error);
                Thread.sleep(100);
            }
        }
        throw failure;
    }
    private LocalDaemon() {}
}
