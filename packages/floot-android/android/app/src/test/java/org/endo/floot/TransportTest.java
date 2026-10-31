package org.endo.floot;

import static org.junit.Assert.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import org.junit.Test;

public class TransportTest {
    @Test public void assistantInvocationRequiresIssuedSingleUseHandoff() {
        assertNull(AssistantInvocation.take("forged"));
        String first = AssistantInvocation.issue();
        assertEquals(first, AssistantInvocation.take(first));
        assertNull(AssistantInvocation.take(first));
        String superseded = AssistantInvocation.issue();
        String current = AssistantInvocation.issue();
        assertNull(AssistantInvocation.take(superseded));
        assertEquals(current, AssistantInvocation.take(current));
    }

    @Test public void assistantMetadataMeetsAndroidParserContract() throws Exception {
        javax.xml.parsers.DocumentBuilder parser = javax.xml.parsers.DocumentBuilderFactory.newInstance().newDocumentBuilder();
        org.w3c.dom.Element metadata = parser.parse(new File("src/main/res/xml/voice_interaction.xml")).getDocumentElement();
        // VoiceInteractionServiceInfo rejects the wrong root and missing recognizer
        // attribute before the role request can show a selection dialog.
        assertEquals("voice-interaction-service", metadata.getTagName());
        assertEquals("true", metadata.getAttribute("android:supportsAssist"));
        assertEquals("org.endo.floot.FlootSessionService", metadata.getAttribute("android:sessionService"));
        assertTrue(metadata.hasAttribute("android:recognitionService"));
        assertEquals("", metadata.getAttribute("android:recognitionService"));
        // An empty recognizer is supported on Android 12+. Earlier systems use
        // the ASSIST activity instead of selecting an invalid speech recognizer.
        org.w3c.dom.Document oldConfig = parser.parse(new File("src/main/res/values/assistant.xml"));
        org.w3c.dom.Document newConfig = parser.parse(new File("src/main/res/values-v31/assistant.xml"));
        assertEquals("false", oldConfig.getElementsByTagName("bool").item(0).getTextContent());
        assertEquals("true", newConfig.getElementsByTagName("bool").item(0).getTextContent());
        org.w3c.dom.Document manifest = parser.parse(new File("src/main/AndroidManifest.xml"));
        org.w3c.dom.NodeList services = manifest.getElementsByTagName("service");
        boolean found = false;
        for (int i = 0; i < services.getLength(); i++) {
            org.w3c.dom.Element service = (org.w3c.dom.Element) services.item(i);
            if (".FlootVoiceService".equals(service.getAttribute("android:name"))) {
                assertEquals("@bool/voice_interaction_enabled", service.getAttribute("android:enabled"));
                assertEquals("android.permission.BIND_VOICE_INTERACTION", service.getAttribute("android:permission"));
                found = true;
            }
        }
        assertTrue(found);
        org.w3c.dom.Element activity = (org.w3c.dom.Element) manifest.getElementsByTagName("activity").item(0);
        boolean assist = false;
        org.w3c.dom.NodeList filters = activity.getElementsByTagName("intent-filter");
        for (int i = 0; i < filters.getLength(); i++) {
            org.w3c.dom.Element filter = (org.w3c.dom.Element) filters.item(i);
            org.w3c.dom.Element action = (org.w3c.dom.Element) filter.getElementsByTagName("action").item(0);
            if ("android.intent.action.ASSIST".equals(action.getAttribute("android:name"))) {
                org.w3c.dom.Element category = (org.w3c.dom.Element) filter.getElementsByTagName("category").item(0);
                assertEquals("android.intent.category.DEFAULT", category.getAttribute("android:name"));
                assist = true;
            }
        }
        assertTrue(assist);
    }

    @Test public void webViewCaptureDeclaresBothRequiredAndroidPermissions() throws Exception {
        // Chromium refuses device selection without either permission, even if
        // the user has granted RECORD_AUDIO in the runtime permission dialog.
        org.w3c.dom.Document manifest = javax.xml.parsers.DocumentBuilderFactory.newInstance()
            .newDocumentBuilder().parse(new File("src/main/AndroidManifest.xml"));
        org.w3c.dom.NodeList permissions = manifest.getElementsByTagName("uses-permission");
        java.util.Set<String> names = new java.util.HashSet<>();
        for (int i = 0; i < permissions.getLength(); i++)
            names.add(((org.w3c.dom.Element) permissions.item(i)).getAttribute("android:name"));
        assertTrue(names.contains("android.permission.RECORD_AUDIO"));
        assertTrue(names.contains("android.permission.MODIFY_AUDIO_SETTINGS"));
    }
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
