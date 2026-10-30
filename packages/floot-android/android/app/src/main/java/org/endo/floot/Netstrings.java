package org.endo.floot;

import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/** Bounded UTF-8 CapTP framing; lengths count bytes, not Java characters. */
final class Netstrings {
    static final int MAX_BYTES = 16 * 1024 * 1024;
    static String read(InputStream input) throws IOException {
        int length = 0;
        int digits = 0;
        for (;;) {
            int next = input.read();
            if (next < 0) throw new EOFException();
            if (next == ':' && digits > 0) break;
            if (next < '0' || next > '9' || ++digits > 8) throw new IOException("Invalid frame length");
            length = length * 10 + next - '0';
            if (length > MAX_BYTES) throw new IOException("Frame too large");
        }
        byte[] bytes = new byte[length];
        int offset = 0;
        while (offset < length) {
            int count = input.read(bytes, offset, length - offset);
            if (count < 0) throw new EOFException();
            offset += count;
        }
        if (input.read() != ',') throw new IOException("Invalid frame terminator");
        return new String(bytes, StandardCharsets.UTF_8);
    }
    static void write(OutputStream output, String message) throws IOException {
        byte[] bytes = message.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_BYTES) throw new IOException("Frame too large");
        output.write((bytes.length + ":").getBytes(StandardCharsets.US_ASCII));
        output.write(bytes);
        output.write(',');
        output.flush();
    }
    private Netstrings() {}
}
