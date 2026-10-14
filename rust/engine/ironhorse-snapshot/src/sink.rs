//! Where encoded bytes go.
//!
//! Every payload encoder in this crate writes through [`Sink`] rather than
//! returning a `Vec<u8>`, so one encoder serves three consumers with the
//! same bytes: an owned buffer (the store's section payloads and the image
//! writer's atoms), a [`ByteCounter`] (the streaming writer's sizing pass,
//! which must know every atom's length before the first byte of its header
//! goes out), and a [`WriteSink`] over a file or any other `io::Write`.
//! The streaming whole-heap writer exists because a checkpoint used to hold
//! several copies of the heap (WASM-BLOCKERS.md B7, "Checkpointing needs
//! several copies of the heap"); with the encoders sink-generic, nothing on
//! that path buffers a payload.

use std::io;

/// A byte sink. Infallible by design: an I/O sink records its first error
/// and drops what follows, and the caller reads the error back when it
/// finishes (see [`WriteSink::finish`]), so the encoders stay plain
/// straight-line code.
pub(crate) trait Sink {
    fn put(&mut self, bytes: &[u8]);

    #[inline]
    fn put_u8(&mut self, byte: u8) {
        self.put(&[byte]);
    }
}

impl Sink for Vec<u8> {
    #[inline]
    fn put(&mut self, bytes: &[u8]) {
        self.extend_from_slice(bytes);
    }

    #[inline]
    fn put_u8(&mut self, byte: u8) {
        self.push(byte);
    }
}

impl<S: Sink + ?Sized> Sink for &mut S {
    #[inline]
    fn put(&mut self, bytes: &[u8]) {
        (**self).put(bytes);
    }

    #[inline]
    fn put_u8(&mut self, byte: u8) {
        (**self).put_u8(byte);
    }
}

/// Counts the bytes it is given and keeps none of them: the sizing pass.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct ByteCounter {
    pub(crate) len: u64,
}

impl Sink for ByteCounter {
    #[inline]
    fn put(&mut self, bytes: &[u8]) {
        self.len += bytes.len() as u64;
    }

    #[inline]
    fn put_u8(&mut self, _byte: u8) {
        self.len += 1;
    }
}

/// Counts the bytes that pass through to `inner`, so the streaming writer
/// can check each atom's payload against the length its header declared.
pub(crate) struct Counting<'a, S: Sink> {
    pub(crate) inner: &'a mut S,
    pub(crate) len: u64,
}

impl<S: Sink> Sink for Counting<'_, S> {
    #[inline]
    fn put(&mut self, bytes: &[u8]) {
        self.len += bytes.len() as u64;
        self.inner.put(bytes);
    }

    #[inline]
    fn put_u8(&mut self, byte: u8) {
        self.len += 1;
        self.inner.put_u8(byte);
    }
}

/// The size of the chunks a [`WriteSink`] hands its writer: the slot
/// records of the `HEAP` atom arrive twenty bytes at a time, and a file
/// write per record would be the cost that dominates.
const WRITE_CHUNK: usize = 64 * 1024;

/// A buffered sink over any `io::Write`, with the first error made sticky:
/// after it, nothing more is written and [`WriteSink::finish`] reports it.
pub(crate) struct WriteSink<'a> {
    out: &'a mut dyn io::Write,
    buffer: Vec<u8>,
    written: u64,
    error: Option<io::Error>,
}

impl<'a> WriteSink<'a> {
    pub(crate) fn new(out: &'a mut dyn io::Write) -> WriteSink<'a> {
        WriteSink {
            out,
            buffer: Vec::with_capacity(WRITE_CHUNK),
            written: 0,
            error: None,
        }
    }

    fn write_through(&mut self, bytes: &[u8]) {
        if self.error.is_some() {
            return;
        }
        match self.out.write_all(bytes) {
            Ok(()) => self.written += bytes.len() as u64,
            Err(error) => self.error = Some(error),
        }
    }

    fn drain(&mut self) {
        let buffered = std::mem::take(&mut self.buffer);
        self.write_through(&buffered);
        self.buffer = buffered;
        self.buffer.clear();
    }

    /// Write out what is buffered and report the bytes written, or the first
    /// error the writer returned.
    pub(crate) fn finish(mut self) -> io::Result<u64> {
        self.drain();
        match self.error.take() {
            Some(error) => Err(error),
            None => Ok(self.written),
        }
    }
}

impl Sink for WriteSink<'_> {
    fn put(&mut self, bytes: &[u8]) {
        if self.error.is_some() {
            return;
        }
        if bytes.len() >= WRITE_CHUNK {
            self.drain();
            self.write_through(bytes);
            return;
        }
        self.buffer.extend_from_slice(bytes);
        if self.buffer.len() >= WRITE_CHUNK {
            self.drain();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vec_counter_and_write_sinks_agree() {
        let mut owned = Vec::new();
        let mut counter = ByteCounter::default();
        let mut file = Vec::new();
        let mut write = WriteSink::new(&mut file);
        let big = vec![7u8; WRITE_CHUNK + 3];
        for sink in [&mut owned as &mut dyn Sink, &mut counter, &mut write] {
            sink.put(b"abc");
            sink.put_u8(9);
            sink.put(&big);
            sink.put(b"");
        }
        let written = write.finish().unwrap();
        assert_eq!(owned.len() as u64, counter.len);
        assert_eq!(written, counter.len);
        assert_eq!(file, owned);
    }

    #[test]
    fn a_failing_writer_is_reported_once_at_finish() {
        struct Refuse;
        impl io::Write for Refuse {
            fn write(&mut self, _: &[u8]) -> io::Result<usize> {
                Err(io::Error::other("full"))
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        let mut refuse = Refuse;
        let mut sink = WriteSink::new(&mut refuse);
        sink.put(&vec![0u8; 2 * WRITE_CHUNK]);
        sink.put(b"after the error");
        let error = sink.finish().unwrap_err();
        assert_eq!(error.to_string(), "full");
    }
}
