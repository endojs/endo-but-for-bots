package org.endo.floot;

import android.app.Application;
import java.io.PrintWriter;
import java.io.StringWriter;

public final class FlootApplication extends Application {
    @Override public void onCreate() {
        super.onCreate();
        Thread.UncaughtExceptionHandler previous = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((thread, error) -> {
            StringWriter text = new StringWriter();
            error.printStackTrace(new PrintWriter(text));
            Diagnostics.record(this, "uncaught native / " + thread.getName(), text.toString());
            if (previous != null) previous.uncaughtException(thread, error);
        });
        Diagnostics.record(this, "lifecycle", "Application process started");
    }
}
