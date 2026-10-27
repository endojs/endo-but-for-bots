package org.endo.floot;

import static org.junit.Assert.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import org.junit.Test;

public class TransportTest {
    @Test public void framesCountUtf8BytesAndReadSuccessiveMessages() throws Exception {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        Netstrings.write(bytes, "hello 🌊"); Netstrings.write(bytes, "next");
        ByteArrayInputStream input = new ByteArrayInputStream(bytes.toByteArray());
        assertEquals("hello 🌊", Netstrings.read(input));
        assertEquals("next", Netstrings.read(input));
    }
    @Test public void malformedAndOversizedFramesFailClosed() {
        for (String invalid : new String[]{"-1:x,", "16777217:", "2:x,", "1:x;", ":,"}) {
            assertThrows(IOException.class, () -> Netstrings.read(new ByteArrayInputStream(invalid.getBytes(StandardCharsets.UTF_8))));
        }
    }
    @Test public void remoteOriginIgnoresCredentialsInFragmentButNotPort() {
        assertEquals("https://endo.example", ConnectionUrl.origin("https://endo.example/ui/#gateway=a&agent=secret"));
        assertTrue(ConnectionUrl.matchesOrigin("https://endo.example:443/a", "https://endo.example"));
        assertFalse(ConnectionUrl.matchesOrigin("https://endo.example:8443/", "https://endo.example"));
        assertFalse(ConnectionUrl.matchesOrigin("https://endo.example.evil/", "https://endo.example"));
        assertFalse(ConnectionUrl.matchesOrigin("https://endo.example@evil/", "https://endo.example"));
        assertThrows(IllegalArgumentException.class, () -> ConnectionUrl.origin("javascript:alert(1)"));
        assertThrows(IllegalArgumentException.class, () -> ConnectionUrl.origin("http://endo.example"));
    }
    @Test public void diagnosticSecretsAreRedacted() {
        String text = Diagnostics.redact("https://endo.example/#gateway=x&agent=secret endo://abc/def Bearer secret token=private");
        assertFalse(text.contains("secret")); assertFalse(text.contains("private"));
        assertFalse(text.contains("abc/def")); assertTrue(text.contains("[redacted]"));
    }
    @Test public void diagnosticPreviewIsBoundedWhileExportRetainsAllStreams() throws Exception {
        java.nio.file.Path directory = java.nio.file.Files.createTempDirectory("floot-report-");
        try {
            for (String name : new String[]{"app", "voice", "daemon"}) {
                for (String suffix : new String[]{"", "-previous"}) {
                    java.nio.file.Files.write(directory.resolve(name + suffix + ".log"),
                        ("x".repeat(Diagnostics.LIMIT - 100) + "\nlatest " + name + suffix + "\n").getBytes(StandardCharsets.UTF_8));
                }
            }
            String preview = Diagnostics.reportFiles(directory.toFile(), 8192);
            String full = Diagnostics.reportFiles(directory.toFile(), Diagnostics.LIMIT);
            assertTrue(preview.length() < 50000);
            assertTrue(full.length() > 1500000);
            for (String name : new String[]{"app", "voice", "daemon"}) {
                assertTrue(preview.contains("latest " + name + "-previous"));
                assertTrue(preview.contains("latest " + name + "\n"));
            }
        } finally {
            for (File file : directory.toFile().listFiles()) java.nio.file.Files.delete(file.toPath());
            java.nio.file.Files.delete(directory);
        }
    }
    @Test public void backgroundLogsRotateAndSurviveReopeningWithBoundedLines() throws Exception {
        java.nio.file.Path directory = java.nio.file.Files.createTempDirectory("floot-logs-");
        try {
            String noisy = "x".repeat(1000000) + "\nbackground failure\n";
            Diagnostics.drain(directory.toFile(), new ByteArrayInputStream(noisy.getBytes(StandardCharsets.UTF_8)));
            String log = new String(java.nio.file.Files.readAllBytes(directory.resolve("daemon.log")), StandardCharsets.UTF_8);
            assertTrue(log.contains("[truncated]")); assertTrue(log.contains("background failure"));
            for (int i = 0; i < 100; i++) Diagnostics.recordFile(directory.toFile(), "daemon", "Endo", "y".repeat(8192));
            Diagnostics.drain(directory.toFile(), new ByteArrayInputStream("after reconnect\n".getBytes(StandardCharsets.UTF_8)));
            assertTrue(new String(java.nio.file.Files.readAllBytes(directory.resolve("daemon.log")), StandardCharsets.UTF_8).contains("after reconnect"));
            File[] files = directory.toFile().listFiles();
            assertEquals(2, files.length);
            for (File file : files) assertTrue(file.length() <= Diagnostics.LIMIT);
        } finally {
            for (File file : directory.toFile().listFiles()) java.nio.file.Files.delete(file.toPath());
            java.nio.file.Files.delete(directory);
        }
    }
}
