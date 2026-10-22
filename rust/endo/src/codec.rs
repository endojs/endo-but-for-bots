use std::io::{self, Read, Write};

use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::types::{Envelope, Handle, MeterMode, MeterState, WorkerInfo};

const CBOR_UINT: u8 = 0;
const CBOR_NEGINT: u8 = 1;
const CBOR_BYTES: u8 = 2;
const CBOR_TEXT: u8 = 3;
const CBOR_ARRAY: u8 = 4;
const CBOR_MAP: u8 = 5;

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

fn cbor_append_head(buf: &mut Vec<u8>, major: u8, n: u64) {
    let m = major << 5;
    if n < 24 {
        buf.push(m | n as u8);
    } else if n <= 0xff {
        buf.push(m | 24);
        buf.push(n as u8);
    } else if n <= 0xffff {
        buf.push(m | 25);
        buf.extend_from_slice(&(n as u16).to_be_bytes());
    } else if n <= 0xffff_ffff {
        buf.push(m | 26);
        buf.extend_from_slice(&(n as u32).to_be_bytes());
    } else {
        buf.push(m | 27);
        buf.extend_from_slice(&n.to_be_bytes());
    }
}

fn cbor_append_int(buf: &mut Vec<u8>, n: i64) {
    if n >= 0 {
        cbor_append_head(buf, CBOR_UINT, n as u64);
    } else {
        cbor_append_head(buf, CBOR_NEGINT, (-1 - n) as u64);
    }
}

fn cbor_append_bytes(buf: &mut Vec<u8>, data: &[u8]) {
    cbor_append_head(buf, CBOR_BYTES, data.len() as u64);
    buf.extend_from_slice(data);
}

fn cbor_append_text(buf: &mut Vec<u8>, s: &str) {
    cbor_append_head(buf, CBOR_TEXT, s.len() as u64);
    buf.extend_from_slice(s.as_bytes());
}

// ---------------------------------------------------------------------------
// Decoding helpers
// ---------------------------------------------------------------------------

struct Cursor<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Cursor<'a> {
    fn new(data: &'a [u8]) -> Self {
        Cursor { data, pos: 0 }
    }

    fn read_head(&mut self) -> io::Result<(u8, u64)> {
        if self.pos >= self.data.len() {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "CBOR: unexpected end of input"));
        }
        let initial = self.data[self.pos];
        self.pos += 1;
        let major = initial >> 5;
        let info = initial & 0x1f;
        if info < 24 {
            return Ok((major, info as u64));
        }
        let size = match info {
            24 => 1,
            25 => 2,
            26 => 4,
            27 => 8,
            _ => return Err(io::Error::new(io::ErrorKind::InvalidData, format!("CBOR: unsupported info {info}"))),
        };
        if self.pos + size > self.data.len() {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "CBOR: truncated head"));
        }
        let mut value: u64 = 0;
        for i in 0..size {
            value = (value << 8) | self.data[self.pos + i] as u64;
        }
        self.pos += size;
        Ok((major, value))
    }

    /// Check that `len` more bytes remain, without overflowing on a
    /// hostile head value.
    fn checked_len(&self, len: u64, msg: &'static str) -> io::Result<usize> {
        let remaining = self.data.len() - self.pos;
        match usize::try_from(len) {
            Ok(len) if len <= remaining => Ok(len),
            _ => Err(io::Error::new(io::ErrorKind::UnexpectedEof, msg)),
        }
    }

    fn read_int(&mut self) -> io::Result<i64> {
        let (major, value) = self.read_head()?;
        match major {
            0 | 1 => {
                // Checked so an out-of-range head reads as malformed input
                // instead of wrapping (release) or panicking (debug).
                let n = i64::try_from(value)
                    .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "CBOR: int out of range"))?;
                Ok(if major == 0 { n } else { -n - 1 })
            }
            _ => Err(io::Error::new(io::ErrorKind::InvalidData, format!("CBOR: expected int, got major {major}"))),
        }
    }

    fn read_bytes(&mut self) -> io::Result<Vec<u8>> {
        let (major, len) = self.read_head()?;
        if major != CBOR_BYTES {
            return Err(io::Error::new(io::ErrorKind::InvalidData, format!("CBOR: expected bytes, got major {major}")));
        }
        let len = self.checked_len(len, "CBOR: truncated bytes")?;
        let result = self.data[self.pos..self.pos + len].to_vec();
        self.pos += len;
        Ok(result)
    }

    fn read_text(&mut self) -> io::Result<String> {
        let (major, len) = self.read_head()?;
        if major != CBOR_TEXT {
            return Err(io::Error::new(io::ErrorKind::InvalidData, format!("CBOR: expected text, got major {major}")));
        }
        let len = self.checked_len(len, "CBOR: truncated text")?;
        let s = std::str::from_utf8(&self.data[self.pos..self.pos + len])
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        self.pos += len;
        Ok(s.to_string())
    }

    fn read_array_header(&mut self) -> io::Result<u64> {
        let (major, len) = self.read_head()?;
        if major != CBOR_ARRAY {
            return Err(io::Error::new(io::ErrorKind::InvalidData, format!("CBOR: expected array, got major {major}")));
        }
        Ok(len)
    }

    fn read_map_header(&mut self) -> io::Result<u64> {
        let (major, len) = self.read_head()?;
        if major != CBOR_MAP {
            return Err(io::Error::new(io::ErrorKind::InvalidData, format!("CBOR: expected map, got major {major}")));
        }
        Ok(len)
    }

    fn skip(&mut self) -> io::Result<()> {
        let (major, value) = self.read_head()?;
        match major {
            0 | 1 => Ok(()),
            2 | 3 => {
                let len = self.checked_len(value, "CBOR: truncated skip")?;
                self.pos += len;
                Ok(())
            }
            4 => {
                for _ in 0..value {
                    self.skip()?;
                }
                Ok(())
            }
            5 => {
                for _ in 0..value {
                    self.skip()?;
                    self.skip()?;
                }
                Ok(())
            }
            _ => Err(io::Error::new(io::ErrorKind::InvalidData, format!("CBOR: unknown major {major}"))),
        }
    }
}

// ---------------------------------------------------------------------------
// Frame I/O (CBOR byte string wrapper)
// ---------------------------------------------------------------------------

/// Read one CBOR byte-string frame from a reader. Returns None on EOF.
pub fn read_frame(r: &mut impl Read) -> io::Result<Option<Vec<u8>>> {
    let mut first = [0u8; 1];
    match r.read_exact(&mut first) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let major = first[0] >> 5;
    if major != CBOR_BYTES {
        return Err(io::Error::new(io::ErrorKind::InvalidData, format!("frame: expected bytes major 2, got {major}")));
    }
    let info = first[0] & 0x1f;
    let len: usize = if info < 24 {
        info as usize
    } else if info == 24 {
        let mut b = [0u8; 1];
        r.read_exact(&mut b)?;
        b[0] as usize
    } else if info == 25 {
        let mut b = [0u8; 2];
        r.read_exact(&mut b)?;
        ((b[0] as usize) << 8) | b[1] as usize
    } else if info == 26 {
        let mut b = [0u8; 4];
        r.read_exact(&mut b)?;
        ((b[0] as usize) << 24) | ((b[1] as usize) << 16) | ((b[2] as usize) << 8) | b[3] as usize
    } else {
        return Err(io::Error::new(io::ErrorKind::InvalidData, format!("frame: unsupported length info {info}")));
    };
    const MAX_FRAME_SIZE: usize = 16 * 1024 * 1024; // 16 MiB
    if len > MAX_FRAME_SIZE {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("frame: size {len} exceeds maximum {MAX_FRAME_SIZE}"),
        ));
    }
    let mut buf = vec![0u8; len];
    if len > 0 {
        r.read_exact(&mut buf)?;
    }
    Ok(Some(buf))
}

/// Write a CBOR byte-string frame to a writer.
pub fn write_frame(w: &mut impl Write, data: &[u8]) -> io::Result<()> {
    let mut header = Vec::new();
    cbor_append_head(&mut header, CBOR_BYTES, data.len() as u64);
    w.write_all(&header)?;
    w.write_all(data)?;
    w.flush()
}

/// Async version of `read_frame` for use with tokio AsyncRead.
pub async fn async_read_frame(r: &mut (impl AsyncReadExt + Unpin)) -> io::Result<Option<Vec<u8>>> {
    let mut first = [0u8; 1];
    match r.read_exact(&mut first).await {
        Ok(_) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let major = first[0] >> 5;
    if major != CBOR_BYTES {
        return Err(io::Error::new(io::ErrorKind::InvalidData, format!("frame: expected bytes major 2, got {major}")));
    }
    let info = first[0] & 0x1f;
    let len: usize = if info < 24 {
        info as usize
    } else if info == 24 {
        let mut b = [0u8; 1];
        r.read_exact(&mut b).await?;
        b[0] as usize
    } else if info == 25 {
        let mut b = [0u8; 2];
        r.read_exact(&mut b).await?;
        ((b[0] as usize) << 8) | b[1] as usize
    } else if info == 26 {
        let mut b = [0u8; 4];
        r.read_exact(&mut b).await?;
        ((b[0] as usize) << 24) | ((b[1] as usize) << 16) | ((b[2] as usize) << 8) | b[3] as usize
    } else {
        return Err(io::Error::new(io::ErrorKind::InvalidData, format!("frame: unsupported length info {info}")));
    };
    const MAX_FRAME_SIZE: usize = 16 * 1024 * 1024;
    if len > MAX_FRAME_SIZE {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("frame: size {len} exceeds maximum {MAX_FRAME_SIZE}"),
        ));
    }
    let mut buf = vec![0u8; len];
    if len > 0 {
        r.read_exact(&mut buf).await?;
    }
    Ok(Some(buf))
}

/// Async version of `write_frame` for use with tokio AsyncWrite.
pub async fn async_write_frame(w: &mut (impl AsyncWriteExt + Unpin), data: &[u8]) -> io::Result<()> {
    let mut header = Vec::new();
    cbor_append_head(&mut header, CBOR_BYTES, data.len() as u64);
    w.write_all(&header).await?;
    w.write_all(data).await?;
    w.flush().await
}

// ---------------------------------------------------------------------------
// Envelope encoding/decoding
// ---------------------------------------------------------------------------

pub fn encode_envelope(env: &Envelope) -> Vec<u8> {
    let mut buf = Vec::new();
    cbor_append_head(&mut buf, CBOR_ARRAY, 4);
    cbor_append_int(&mut buf, env.handle);
    cbor_append_text(&mut buf, &env.verb);
    cbor_append_bytes(&mut buf, &env.payload);
    cbor_append_int(&mut buf, env.nonce);
    buf
}

pub fn decode_envelope(data: &[u8]) -> io::Result<Envelope> {
    let mut c = Cursor::new(data);
    let n = c.read_array_header()?;
    if n != 3 && n != 4 {
        return Err(io::Error::new(io::ErrorKind::InvalidData, format!("envelope: expected 3 or 4 elements, got {n}")));
    }
    let handle = c.read_int()?;
    let verb = c.read_text()?;
    let payload = c.read_bytes()?;
    let nonce = if n == 4 { c.read_int()? } else { 0 };
    Ok(Envelope { handle, verb, payload, nonce })
}

// ---------------------------------------------------------------------------
// Spawn request encoding/decoding
// ---------------------------------------------------------------------------

pub fn encode_spawn_request(platform: &str, command: &str, args: &[String]) -> Vec<u8> {
    let mut buf = Vec::new();
    cbor_append_head(&mut buf, CBOR_MAP, 3);
    cbor_append_text(&mut buf, "platform");
    cbor_append_text(&mut buf, platform);
    cbor_append_text(&mut buf, "command");
    cbor_append_text(&mut buf, command);
    cbor_append_text(&mut buf, "args");
    cbor_append_head(&mut buf, CBOR_ARRAY, args.len() as u64);
    for arg in args {
        cbor_append_text(&mut buf, arg);
    }
    buf
}

pub fn decode_spawn_request(data: &[u8]) -> io::Result<(String, String, Vec<String>)> {
    let mut c = Cursor::new(data);
    let n = c.read_map_header()?;
    let mut platform = String::new();
    let mut command = String::new();
    let mut args = Vec::new();
    for _ in 0..n {
        let key = c.read_text()?;
        match key.as_str() {
            "platform" => platform = c.read_text()?,
            "command" => command = c.read_text()?,
            "args" => {
                let alen = c.read_array_header()?;
                for _ in 0..alen {
                    args.push(c.read_text()?);
                }
            }
            _ => c.skip()?,
        }
    }
    // Default to "separate" for backward compat with old payloads.
    if platform.is_empty() {
        platform = "separate".to_string();
    }
    Ok((platform, command, args))
}

// ---------------------------------------------------------------------------
// Handle encoding/decoding
// ---------------------------------------------------------------------------

pub fn encode_handle(h: Handle) -> Vec<u8> {
    let mut buf = Vec::new();
    cbor_append_int(&mut buf, h);
    buf
}

pub fn decode_handle(data: &[u8]) -> io::Result<Handle> {
    let mut c = Cursor::new(data);
    c.read_int()
}

// ---------------------------------------------------------------------------
// listen-path request decoding (CBOR map: {"path": <text>})
// ---------------------------------------------------------------------------

pub fn decode_listen_path_request(data: &[u8]) -> io::Result<String> {
    let mut c = Cursor::new(data);
    let n = c.read_map_header()?;
    let mut path = String::new();
    for _ in 0..n {
        let key = c.read_text()?;
        match key.as_str() {
            "path" => path = c.read_text()?,
            _ => c.skip()?,
        }
    }
    if path.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "listen-path: missing or empty path",
        ));
    }
    Ok(path)
}

// ---------------------------------------------------------------------------
// listen-iroh request decoding (CBOR map: {"node": <hex text>})
//
// The manager asks the supervisor to host an iroh network device. The
// payload carries the daemon's NodeNumber (64-hex-character Ed25519 public
// key); the supervisor derives the iroh secret key from it, exactly as the
// Node.js transport does, so the iroh NodeId is stable and consistent.
// ---------------------------------------------------------------------------

pub fn decode_listen_iroh_request(data: &[u8]) -> io::Result<String> {
    let mut c = Cursor::new(data);
    let n = c.read_map_header()?;
    let mut node = String::new();
    for _ in 0..n {
        let key = c.read_text()?;
        match key.as_str() {
            "node" => node = c.read_text()?,
            _ => c.skip()?,
        }
    }
    if node.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "listen-iroh: missing or empty node",
        ));
    }
    Ok(node)
}

// ---------------------------------------------------------------------------
// Suspend request decoding (CBOR map: {"handle": <i64>})
// ---------------------------------------------------------------------------

pub fn decode_suspend_request(data: &[u8]) -> io::Result<Handle> {
    let mut c = Cursor::new(data);
    let n = c.read_map_header()?;
    let mut target: Handle = 0;
    for _ in 0..n {
        let key = c.read_text()?;
        match key.as_str() {
            "handle" => target = c.read_int()?,
            _ => c.skip()?,
        }
    }
    if target == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "suspend: missing or zero handle",
        ));
    }
    Ok(target)
}

// ---------------------------------------------------------------------------
// Worker list encoding
// ---------------------------------------------------------------------------

pub fn encode_worker_list(workers: &[WorkerInfo]) -> Vec<u8> {
    let mut buf = Vec::new();
    cbor_append_head(&mut buf, CBOR_ARRAY, workers.len() as u64);
    for w in workers {
        cbor_append_head(&mut buf, CBOR_MAP, 6);
        cbor_append_text(&mut buf, "handle");
        cbor_append_int(&mut buf, w.handle);
        cbor_append_text(&mut buf, "platform");
        cbor_append_text(&mut buf, &w.platform);
        cbor_append_text(&mut buf, "command");
        cbor_append_text(&mut buf, &w.cmd);
        cbor_append_text(&mut buf, "args");
        cbor_append_head(&mut buf, CBOR_ARRAY, w.args.len() as u64);
        for arg in &w.args {
            cbor_append_text(&mut buf, arg);
        }
        cbor_append_text(&mut buf, "pid");
        cbor_append_int(&mut buf, w.pid as i64);
        cbor_append_text(&mut buf, "started");
        let elapsed = w.started.duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
        let secs = elapsed.as_secs();
        // Format as RFC3339-ish timestamp.
        cbor_append_text(&mut buf, &format_timestamp(secs));
    }
    buf
}

fn format_timestamp(epoch_secs: u64) -> String {
    // Simple UTC timestamp without external deps.
    let s = epoch_secs;
    let days = s / 86400;
    let rem = s % 86400;
    let h = rem / 3600;
    let m = (rem % 3600) / 60;
    let sec = rem % 60;
    // Days since 1970-01-01 to Y-M-D (simplified Gregorian).
    let (y, mo, d) = days_to_ymd(days);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{sec:02}Z")
}

fn days_to_ymd(mut days: u64) -> (u64, u64, u64) {
    let mut y = 1970;
    loop {
        let ydays = if is_leap(y) { 366 } else { 365 };
        if days < ydays {
            break;
        }
        days -= ydays;
        y += 1;
    }
    let leap = is_leap(y);
    let mdays = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut mo = 0;
    for (i, &md) in mdays.iter().enumerate() {
        if days < md {
            mo = i as u64 + 1;
            break;
        }
        days -= md;
    }
    (y, mo, days + 1)
}

fn is_leap(y: u64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

// ---------------------------------------------------------------------------
// Metering codec functions
// ---------------------------------------------------------------------------

/// Decode a meter-report payload.
/// CBOR map: {"handle": <i64>, "steps": <u64>, "outcome": <text>}
pub fn decode_meter_report(data: &[u8]) -> io::Result<(Handle, u64, String)> {
    let mut c = Cursor::new(data);
    let n = c.read_map_header()?;
    let mut handle: Handle = 0;
    let mut steps: u64 = 0;
    let mut outcome = String::new();
    for _ in 0..n {
        let key = c.read_text()?;
        match key.as_str() {
            "handle" => handle = c.read_int()?,
            "steps" => steps = c.read_int()? as u64,
            "outcome" => outcome = c.read_text()?,
            _ => c.skip()?,
        }
    }
    Ok((handle, steps, outcome))
}

/// Decode a handle-bearing request payload.
/// CBOR map: {"handle": <i64>}
pub fn decode_handle_request(data: &[u8]) -> io::Result<Handle> {
    let mut c = Cursor::new(data);
    let n = c.read_map_header()?;
    let mut handle: Handle = 0;
    for _ in 0..n {
        let key = c.read_text()?;
        match key.as_str() {
            "handle" => handle = c.read_int()?,
            _ => c.skip()?,
        }
    }
    if handle == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "meter request: missing or zero handle",
        ));
    }
    Ok(handle)
}

/// Encode a meter-query response.
/// CBOR map with the target handle and current meter state fields.
pub fn encode_meter_query_response(target: Handle, state: Option<&MeterState>) -> Vec<u8> {
    let mut buf = Vec::new();
    match state {
        Some(s) => {
            let mode_str = match s.mode {
                MeterMode::Measurement => "measurement",
                MeterMode::Quota => "quota",
                MeterMode::RateLimited => "rate-limited",
            };
            cbor_append_head(&mut buf, CBOR_MAP, 5);
            cbor_append_text(&mut buf, "handle");
            cbor_append_int(&mut buf, target);
            cbor_append_text(&mut buf, "mode");
            cbor_append_text(&mut buf, mode_str);
            cbor_append_text(&mut buf, "accumulated");
            cbor_append_head(&mut buf, CBOR_UINT, s.accumulated);
            cbor_append_text(&mut buf, "budget");
            cbor_append_head(&mut buf, CBOR_UINT, s.budget);
            cbor_append_text(&mut buf, "hardLimit");
            cbor_append_head(&mut buf, CBOR_UINT, s.hard_limit);
        }
        None => {
            cbor_append_head(&mut buf, CBOR_MAP, 2);
            cbor_append_text(&mut buf, "handle");
            cbor_append_int(&mut buf, target);
            cbor_append_text(&mut buf, "mode");
            cbor_append_text(&mut buf, "measurement");
        }
    }
    buf
}

/// Decode a meter-set-quota payload.
/// CBOR map: {"handle": <i64>, "hardLimit": <u64>, "budget": <u64>}
pub fn decode_meter_set_quota(data: &[u8]) -> io::Result<(Handle, u64, u64)> {
    let mut c = Cursor::new(data);
    let n = c.read_map_header()?;
    let mut handle: Handle = 0;
    let mut hard_limit: u64 = 0;
    let mut budget: u64 = 0;
    for _ in 0..n {
        let key = c.read_text()?;
        match key.as_str() {
            "handle" => handle = c.read_int()?,
            "hardLimit" => hard_limit = c.read_int()? as u64,
            "budget" => budget = c.read_int()? as u64,
            _ => c.skip()?,
        }
    }
    if handle == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "meter-set-quota: missing or zero handle",
        ));
    }
    Ok((handle, hard_limit, budget))
}

/// Decode a meter-set-rate payload.
/// CBOR map: {"handle": <i64>, "hardLimit": <u64>, "rate": <u64>, "burst": <u64>}
pub fn decode_meter_set_rate(data: &[u8]) -> io::Result<(Handle, u64, u64, u64)> {
    let mut c = Cursor::new(data);
    let n = c.read_map_header()?;
    let mut handle: Handle = 0;
    let mut hard_limit: u64 = 0;
    let mut rate: u64 = 0;
    let mut burst: u64 = 0;
    for _ in 0..n {
        let key = c.read_text()?;
        match key.as_str() {
            "handle" => handle = c.read_int()?,
            "hardLimit" => hard_limit = c.read_int()? as u64,
            "rate" => rate = c.read_int()? as u64,
            "burst" => burst = c.read_int()? as u64,
            _ => c.skip()?,
        }
    }
    if handle == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "meter-set-rate: missing or zero handle",
        ));
    }
    Ok((handle, hard_limit, rate, burst))
}

/// Decode a meter-refill payload.
/// CBOR map: {"handle": <i64>, "amount": <u64>}
pub fn decode_meter_refill(data: &[u8]) -> io::Result<(Handle, u64)> {
    let mut c = Cursor::new(data);
    let n = c.read_map_header()?;
    let mut handle: Handle = 0;
    let mut amount: u64 = 0;
    for _ in 0..n {
        let key = c.read_text()?;
        match key.as_str() {
            "handle" => handle = c.read_int()?,
            "amount" => amount = c.read_int()? as u64,
            _ => c.skip()?,
        }
    }
    if handle == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "meter-refill: missing or zero handle",
        ));
    }
    Ok((handle, amount))
}

/// Encode a meter-refill acknowledgement.
/// CBOR map: {"handle": <i64>, "budget": <u64>}
pub fn encode_meter_refill_response(target: Handle, new_budget: u64) -> Vec<u8> {
    let mut buf = Vec::new();
    cbor_append_head(&mut buf, CBOR_MAP, 2);
    cbor_append_text(&mut buf, "handle");
    cbor_append_int(&mut buf, target);
    cbor_append_text(&mut buf, "budget");
    cbor_append_head(&mut buf, CBOR_UINT, new_budget);
    buf
}

/// Encode a meter-config envelope payload.
/// CBOR map: {"hardLimit": <u64>}
pub fn encode_meter_config(hard_limit: u64) -> Vec<u8> {
    let mut buf = Vec::new();
    cbor_append_head(&mut buf, CBOR_MAP, 1);
    cbor_append_text(&mut buf, "hardLimit");
    cbor_append_head(&mut buf, CBOR_UINT, hard_limit);
    buf
}

// ---------------------------------------------------------------------------
// CAS verb codec
// ---------------------------------------------------------------------------

/// Decode `cas-store` payload: CBOR map `{"data": <bytes>, "type": <text>}`.
/// Returns `(data, content_type)`.
pub fn decode_cas_store(data: &[u8]) -> io::Result<(Vec<u8>, String)> {
    let mut c = Cursor::new(data);
    let n = c.read_map_header()?;
    let mut blob_data: Vec<u8> = Vec::new();
    let mut content_type = "blob".to_string();
    for _ in 0..n {
        let key = c.read_text()?;
        match key.as_str() {
            "data" => blob_data = c.read_bytes()?,
            "type" => content_type = c.read_text()?,
            _ => c.skip()?,
        }
    }
    Ok((blob_data, content_type))
}

/// Encode `cas-stored` response: CBOR map `{"hash": <text>}`.
pub fn encode_cas_stored(hash: &str) -> Vec<u8> {
    let mut buf = Vec::new();
    cbor_append_head(&mut buf, CBOR_MAP, 1);
    cbor_append_text(&mut buf, "hash");
    cbor_append_text(&mut buf, hash);
    buf
}

/// Decode `cas-fetch` / `cas-has` payload: CBOR map `{"hash": <text>}`.
/// Returns the hash string.
pub fn decode_cas_hash_request(data: &[u8]) -> io::Result<String> {
    let mut c = Cursor::new(data);
    let n = c.read_map_header()?;
    let mut hash = String::new();
    for _ in 0..n {
        let key = c.read_text()?;
        match key.as_str() {
            "hash" => hash = c.read_text()?,
            _ => c.skip()?,
        }
    }
    Ok(hash)
}

/// Encode `cas-content` response: raw bytes as CBOR map `{"data": <bytes>}`.
pub fn encode_cas_content(data: &[u8]) -> Vec<u8> {
    let mut buf = Vec::new();
    cbor_append_head(&mut buf, CBOR_MAP, 1);
    cbor_append_text(&mut buf, "data");
    cbor_append_head(&mut buf, CBOR_BYTES, data.len() as u64);
    buf.extend_from_slice(data);
    buf
}

/// Encode `cas-gc-done` response: CBOR map `{"freedCount": <u64>, "freedBytes": <u64>}`.
pub fn encode_gc_report(freed_count: u64, freed_bytes: u64) -> Vec<u8> {
    let mut buf = Vec::new();
    cbor_append_head(&mut buf, CBOR_MAP, 2);
    cbor_append_text(&mut buf, "freedCount");
    cbor_append_head(&mut buf, CBOR_UINT, freed_count);
    cbor_append_text(&mut buf, "freedBytes");
    cbor_append_head(&mut buf, CBOR_UINT, freed_bytes);
    buf
}

/// Encode `cas-exists` response: CBOR map `{"exists": <bool>}`.
pub fn encode_cas_exists(exists: bool) -> Vec<u8> {
    let mut buf = Vec::new();
    cbor_append_head(&mut buf, CBOR_MAP, 1);
    cbor_append_text(&mut buf, "exists");
    // CBOR true = 0xf5, false = 0xf4 (simple values 20/21).
    buf.push(if exists { 0xf5 } else { 0xf4 });
    buf
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::SystemTime;

    #[test]
    fn spawn_request_round_trip_separate() {
        let args = vec!["arg1".to_string(), "arg2".to_string()];
        let encoded = encode_spawn_request("separate", "/bin/worker", &args);
        let (platform, command, decoded_args) = decode_spawn_request(&encoded).unwrap();
        assert_eq!(platform, "separate");
        assert_eq!(command, "/bin/worker");
        assert_eq!(decoded_args, args);
    }

    #[test]
    fn spawn_request_round_trip_shared() {
        let encoded = encode_spawn_request("shared", "", &[]);
        let (platform, command, args) = decode_spawn_request(&encoded).unwrap();
        assert_eq!(platform, "shared");
        assert_eq!(command, "");
        assert!(args.is_empty());
    }

    #[test]
    fn spawn_request_legacy_no_platform() {
        // Simulate a legacy 2-entry map without "platform" key.
        let mut buf = Vec::new();
        cbor_append_head(&mut buf, CBOR_MAP, 2);
        cbor_append_text(&mut buf, "command");
        cbor_append_text(&mut buf, "/bin/old-worker");
        cbor_append_text(&mut buf, "args");
        cbor_append_head(&mut buf, CBOR_ARRAY, 0);
        let (platform, command, args) = decode_spawn_request(&buf).unwrap();
        assert_eq!(platform, "separate"); // default
        assert_eq!(command, "/bin/old-worker");
        assert!(args.is_empty());
    }

    #[test]
    fn worker_list_includes_platform() {
        let workers = vec![WorkerInfo {
            handle: 42,
            platform: "shared".to_string(),
            cmd: "<in-process>".to_string(),
            args: Vec::new(),
            pid: 1234,
            started: SystemTime::UNIX_EPOCH,
        }];
        let encoded = encode_worker_list(&workers);
        // Decode and verify the platform field is present.
        let mut c = Cursor::new(&encoded);
        let n = c.read_array_header().unwrap();
        assert_eq!(n, 1);
        let map_len = c.read_map_header().unwrap();
        assert_eq!(map_len, 6);
        let mut found_platform = false;
        for _ in 0..map_len {
            let key = c.read_text().unwrap();
            if key == "platform" {
                let val = c.read_text().unwrap();
                assert_eq!(val, "shared");
                found_platform = true;
            } else {
                c.skip().unwrap();
            }
        }
        assert!(found_platform, "platform field not found in worker list");
    }

    // --- Metering codec tests ---

    #[test]
    fn meter_report_round_trip() {
        // Encode a meter-report payload manually, then decode.
        let mut buf = Vec::new();
        cbor_append_head(&mut buf, CBOR_MAP, 3);
        cbor_append_text(&mut buf, "handle");
        cbor_append_int(&mut buf, 7);
        cbor_append_text(&mut buf, "steps");
        cbor_append_head(&mut buf, CBOR_UINT, 42000);
        cbor_append_text(&mut buf, "outcome");
        cbor_append_text(&mut buf, "ok");

        let (handle, steps, outcome) = decode_meter_report(&buf).unwrap();
        assert_eq!(handle, 7);
        assert_eq!(steps, 42000);
        assert_eq!(outcome, "ok");
    }

    #[test]
    fn meter_report_terminated() {
        let mut buf = Vec::new();
        cbor_append_head(&mut buf, CBOR_MAP, 3);
        cbor_append_text(&mut buf, "handle");
        cbor_append_int(&mut buf, 3);
        cbor_append_text(&mut buf, "steps");
        cbor_append_head(&mut buf, CBOR_UINT, 100_000);
        cbor_append_text(&mut buf, "outcome");
        cbor_append_text(&mut buf, "terminated");

        let (handle, steps, outcome) = decode_meter_report(&buf).unwrap();
        assert_eq!(handle, 3);
        assert_eq!(steps, 100_000);
        assert_eq!(outcome, "terminated");
    }

    #[test]
    fn handle_request_round_trip() {
        let mut buf = Vec::new();
        cbor_append_head(&mut buf, CBOR_MAP, 1);
        cbor_append_text(&mut buf, "handle");
        cbor_append_int(&mut buf, 99);

        let h = decode_handle_request(&buf).unwrap();
        assert_eq!(h, 99);
    }

    #[test]
    fn handle_request_missing_handle() {
        let mut buf = Vec::new();
        cbor_append_head(&mut buf, CBOR_MAP, 0);

        assert!(decode_handle_request(&buf).is_err());
    }

    #[test]
    fn meter_query_response_with_state() {
        let state = MeterState {
            mode: MeterMode::Quota,
            accumulated: 5000,
            budget: 3000,
            hard_limit: 1000,
            rate_limit: None,
        };
        let encoded = encode_meter_query_response(42, Some(&state));
        let mut c = Cursor::new(&encoded);
        let n = c.read_map_header().unwrap();
        assert_eq!(n, 5);
        let mut mode = String::new();
        let mut accumulated = 0u64;
        let mut budget = 0u64;
        let mut hard_limit = 0u64;
        for _ in 0..n {
            let key = c.read_text().unwrap();
            match key.as_str() {
                "mode" => mode = c.read_text().unwrap(),
                "accumulated" => accumulated = c.read_int().unwrap() as u64,
                "budget" => budget = c.read_int().unwrap() as u64,
                "hardLimit" => hard_limit = c.read_int().unwrap() as u64,
                _ => c.skip().unwrap(),
            }
        }
        assert_eq!(mode, "quota");
        assert_eq!(accumulated, 5000);
        assert_eq!(budget, 3000);
        assert_eq!(hard_limit, 1000);
    }

    #[test]
    fn meter_query_response_no_state() {
        let encoded = encode_meter_query_response(42, None);
        let mut c = Cursor::new(&encoded);
        let n = c.read_map_header().unwrap();
        assert_eq!(n, 2);
        let mut mode = String::new();
        for _ in 0..n {
            let key = c.read_text().unwrap();
            match key.as_str() {
                "mode" => mode = c.read_text().unwrap(),
                _ => c.skip().unwrap(),
            }
        }
        assert_eq!(mode, "measurement");
    }

    #[test]
    fn meter_set_quota_round_trip() {
        let mut buf = Vec::new();
        cbor_append_head(&mut buf, CBOR_MAP, 3);
        cbor_append_text(&mut buf, "handle");
        cbor_append_int(&mut buf, 5);
        cbor_append_text(&mut buf, "hardLimit");
        cbor_append_head(&mut buf, CBOR_UINT, 10_000);
        cbor_append_text(&mut buf, "budget");
        cbor_append_head(&mut buf, CBOR_UINT, 50_000);

        let (h, hl, b) = decode_meter_set_quota(&buf).unwrap();
        assert_eq!(h, 5);
        assert_eq!(hl, 10_000);
        assert_eq!(b, 50_000);
    }

    #[test]
    fn meter_set_rate_round_trip() {
        let mut buf = Vec::new();
        cbor_append_head(&mut buf, CBOR_MAP, 4);
        cbor_append_text(&mut buf, "handle");
        cbor_append_int(&mut buf, 8);
        cbor_append_text(&mut buf, "hardLimit");
        cbor_append_head(&mut buf, CBOR_UINT, 5_000);
        cbor_append_text(&mut buf, "rate");
        cbor_append_head(&mut buf, CBOR_UINT, 1_000);
        cbor_append_text(&mut buf, "burst");
        cbor_append_head(&mut buf, CBOR_UINT, 20_000);

        let (h, hl, r, b) = decode_meter_set_rate(&buf).unwrap();
        assert_eq!(h, 8);
        assert_eq!(hl, 5_000);
        assert_eq!(r, 1_000);
        assert_eq!(b, 20_000);
    }

    #[test]
    fn meter_refill_round_trip() {
        let mut buf = Vec::new();
        cbor_append_head(&mut buf, CBOR_MAP, 2);
        cbor_append_text(&mut buf, "handle");
        cbor_append_int(&mut buf, 12);
        cbor_append_text(&mut buf, "amount");
        cbor_append_head(&mut buf, CBOR_UINT, 25_000);

        let (h, a) = decode_meter_refill(&buf).unwrap();
        assert_eq!(h, 12);
        assert_eq!(a, 25_000);
    }

    #[test]
    fn meter_refill_response_round_trip() {
        let encoded = encode_meter_refill_response(12, 75_000);
        let mut c = Cursor::new(&encoded);
        let n = c.read_map_header().unwrap();
        assert_eq!(n, 2);
        let mut handle: Handle = 0;
        let mut budget = 0u64;
        for _ in 0..n {
            let key = c.read_text().unwrap();
            match key.as_str() {
                "handle" => handle = c.read_int().unwrap(),
                "budget" => budget = c.read_int().unwrap() as u64,
                _ => c.skip().unwrap(),
            }
        }
        assert_eq!(handle, 12);
        assert_eq!(budget, 75_000);
    }

    #[test]
    fn meter_config_round_trip() {
        let encoded = encode_meter_config(10_000);
        let mut c = Cursor::new(&encoded);
        let n = c.read_map_header().unwrap();
        assert_eq!(n, 1);
        let key = c.read_text().unwrap();
        assert_eq!(key, "hardLimit");
        let val = c.read_int().unwrap() as u64;
        assert_eq!(val, 10_000);
    }

    // CAS codec tests

    #[test]
    fn cas_store_round_trip() {
        // Build a cas-store payload manually.
        let mut buf = Vec::new();
        cbor_append_head(&mut buf, CBOR_MAP, 2);
        cbor_append_text(&mut buf, "data");
        let data = b"hello CAS";
        cbor_append_head(&mut buf, CBOR_BYTES, data.len() as u64);
        buf.extend_from_slice(data);
        cbor_append_text(&mut buf, "type");
        cbor_append_text(&mut buf, "snapshot");

        let (decoded_data, content_type) = decode_cas_store(&buf).unwrap();
        assert_eq!(decoded_data, data);
        assert_eq!(content_type, "snapshot");
    }

    #[test]
    fn cas_stored_decode() {
        let encoded = encode_cas_stored("abc123def456");
        let hash = decode_cas_hash_request(&encoded).unwrap();
        assert_eq!(hash, "abc123def456");
    }

    #[test]
    fn cas_content_round_trip() {
        let data = b"module source";
        let encoded = encode_cas_content(data);
        // Decode manually: map with "data" key.
        let mut c = Cursor::new(&encoded);
        let n = c.read_map_header().unwrap();
        assert_eq!(n, 1);
        let key = c.read_text().unwrap();
        assert_eq!(key, "data");
        let decoded = c.read_bytes().unwrap();
        assert_eq!(decoded, data);
    }

    #[test]
    fn cas_exists_encode() {
        let encoded_true = encode_cas_exists(true);
        // Map with "exists" key and CBOR true (0xf5).
        assert!(encoded_true.contains(&0xf5));

        let encoded_false = encode_cas_exists(false);
        assert!(encoded_false.contains(&0xf4));
    }
}

// ---------------------------------------------------------------------------
// TUI bus verbs (designs/endor-bus-tui.md § Layer 1, Phase 1 subset)
// ---------------------------------------------------------------------------

/// Error codes a `tui.*` verb may answer with in Phase 1.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TuiErrorCode {
    NoSuchWindow,
    NoSuchRegion,
    WrongRole,
    BadArgument,
    TooLarge,
}

impl TuiErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            TuiErrorCode::NoSuchWindow => "no-such-window",
            TuiErrorCode::NoSuchRegion => "no-such-region",
            TuiErrorCode::WrongRole => "wrong-role",
            TuiErrorCode::BadArgument => "bad-argument",
            TuiErrorCode::TooLarge => "too-large",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "no-such-window" => TuiErrorCode::NoSuchWindow,
            "no-such-region" => TuiErrorCode::NoSuchRegion,
            "wrong-role" => TuiErrorCode::WrongRole,
            "bad-argument" => TuiErrorCode::BadArgument,
            "too-large" => TuiErrorCode::TooLarge,
            _ => return None,
        })
    }
}

/// The `{ code, message }` payload of a `tui.*` error reply.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TuiError {
    pub code: TuiErrorCode,
    pub message: String,
}

impl TuiError {
    pub fn new(code: TuiErrorCode, message: impl Into<String>) -> Self {
        TuiError { code, message: message.into() }
    }

    pub fn bad_argument(message: impl Into<String>) -> Self {
        TuiError::new(TuiErrorCode::BadArgument, message)
    }
}

/// A color in a style run: a palette index or a `#rrggbb` string.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TuiColor {
    Index(i64),
    Rgb(String),
}

/// Style attributes of a run. Absent fields inherit the region default.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TuiAttrs {
    pub fg: Option<TuiColor>,
    pub bg: Option<TuiColor>,
    pub bold: Option<bool>,
    pub italic: Option<bool>,
    pub underline: Option<bool>,
    pub reverse: Option<bool>,
    pub strike: Option<bool>,
}

/// One `{ text, attrs }` style run.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TuiRun {
    pub text: String,
    pub attrs: TuiAttrs,
}

/// A window or region layout hint. Every field is optional.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TuiLayoutHint {
    pub min_cols: Option<i64>,
    pub min_rows: Option<i64>,
    pub preferred_cols: Option<i64>,
    pub preferred_rows: Option<i64>,
    pub dock: Option<String>,
    pub priority: Option<i64>,
}

/// A decoded Phase 1 `tui.*` request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TuiRequest {
    GetScreen,
    CreateWindow { screen_id: i64, title: String, role: String, layout_hint: TuiLayoutHint },
    ConfigureWindow { window_id: i64, title: Option<String>, layout_hint: Option<TuiLayoutHint> },
    DestroyWindow { window_id: i64 },
    CreateRegion { window_id: i64, role: String, layout_hint: Option<TuiLayoutHint>, scrollback: Option<i64> },
    DestroyRegion { region_id: i64 },
    SetText { region_id: i64, runs: Vec<TuiRun> },
    AppendLines { region_id: i64, lines: Vec<Vec<TuiRun>> },
}

/// A Phase 1 `tui.*` success reply.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TuiReply {
    Screen {
        screen_id: i64,
        cols: i64,
        rows: i64,
        color_depth: i64,
        has_mouse: bool,
        has_focus: bool,
        attached: bool,
    },
    Window { window_id: i64 },
    Region { region_id: i64 },
    Appended { first_line: i64, last_line: i64 },
    Empty,
}

/// Window roles accepted by `tui.createWindow`.
pub const TUI_WINDOW_ROLES: &[&str] = &["chat", "debugger", "status", "tool", "form", "log"];
/// Region roles named by § Layer 1 (Phase 1 accepts only `text` and `buffer`).
pub const TUI_REGION_ROLES: &[&str] = &["text", "buffer", "status", "input", "canvas"];
/// `layoutHint.dock` values.
pub const TUI_DOCKS: &[&str] = &["top", "bottom", "left", "right", "fill", "float"];

/// Generic CBOR value, enough for the map-shaped `tui.*` payloads.
#[derive(Clone, Debug, PartialEq)]
enum Value {
    Int(i64),
    Bytes(Vec<u8>),
    Text(String),
    Array(Vec<Value>),
    Map(Vec<(String, Value)>),
    Bool(bool),
    Null,
}

const TUI_MAX_DEPTH: usize = 16;
/// Most keys any `tui.*` map carries (run attrs have 7). Capping the
/// count keeps the duplicate-key check and `Fields::take` cheap on the
/// routing loop, whatever a hostile worker sends.
const TUI_MAX_MAP_ENTRIES: u64 = 16;

fn read_value(c: &mut Cursor, depth: usize) -> io::Result<Value> {
    if depth > TUI_MAX_DEPTH {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "CBOR: nesting too deep"));
    }
    let start = c.pos;
    let (major, value) = c.read_head()?;
    match major {
        CBOR_UINT | CBOR_NEGINT => {
            c.pos = start;
            Ok(Value::Int(c.read_int()?))
        }
        CBOR_BYTES => {
            c.pos = start;
            Ok(Value::Bytes(c.read_bytes()?))
        }
        CBOR_TEXT => {
            c.pos = start;
            Ok(Value::Text(c.read_text()?))
        }
        CBOR_ARRAY => {
            let mut items = Vec::new();
            for _ in 0..value {
                items.push(read_value(c, depth + 1)?);
            }
            Ok(Value::Array(items))
        }
        CBOR_MAP => {
            if value > TUI_MAX_MAP_ENTRIES {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("CBOR: map has more than {TUI_MAX_MAP_ENTRIES} entries"),
                ));
            }
            let mut entries: Vec<(String, Value)> = Vec::new();
            for _ in 0..value {
                let key = c.read_text()?;
                if entries.iter().any(|(k, _)| *k == key) {
                    return Err(io::Error::new(io::ErrorKind::InvalidData, format!("CBOR: duplicate key {key}")));
                }
                let v = read_value(c, depth + 1)?;
                entries.push((key, v));
            }
            Ok(Value::Map(entries))
        }
        7 => match value {
            20 => Ok(Value::Bool(false)),
            21 => Ok(Value::Bool(true)),
            22 => Ok(Value::Null),
            _ => Err(io::Error::new(io::ErrorKind::InvalidData, format!("CBOR: unsupported simple value {value}"))),
        },
        _ => Err(io::Error::new(io::ErrorKind::InvalidData, format!("CBOR: unsupported major {major}"))),
    }
}

fn append_value(buf: &mut Vec<u8>, v: &Value) {
    match v {
        Value::Int(n) => cbor_append_int(buf, *n),
        Value::Bytes(b) => cbor_append_bytes(buf, b),
        Value::Text(s) => cbor_append_text(buf, s),
        Value::Array(items) => {
            cbor_append_head(buf, CBOR_ARRAY, items.len() as u64);
            for item in items {
                append_value(buf, item);
            }
        }
        Value::Map(entries) => {
            cbor_append_head(buf, CBOR_MAP, entries.len() as u64);
            for (k, item) in entries {
                cbor_append_text(buf, k);
                append_value(buf, item);
            }
        }
        Value::Bool(false) => buf.push(0xf4),
        Value::Bool(true) => buf.push(0xf5),
        Value::Null => buf.push(0xf6),
    }
}

fn encode_value(v: &Value) -> Vec<u8> {
    let mut buf = Vec::new();
    append_value(&mut buf, v);
    buf
}

/// Decode a whole payload as one map, rejecting trailing bytes.
/// An empty payload reads as an empty map.
fn decode_map(data: &[u8]) -> Result<Fields, TuiError> {
    if data.is_empty() {
        return Ok(Fields { entries: Vec::new(), what: "payload" });
    }
    let mut c = Cursor::new(data);
    let v = read_value(&mut c, 0).map_err(|e| TuiError::bad_argument(format!("payload: {e}")))?;
    if c.pos != data.len() {
        return Err(TuiError::bad_argument("payload: trailing bytes"));
    }
    Fields::from_value(v, "payload")
}

/// A map being destructured: every key must be taken exactly once.
struct Fields {
    entries: Vec<(String, Value)>,
    what: &'static str,
}

impl Fields {
    fn from_value(v: Value, what: &'static str) -> Result<Self, TuiError> {
        match v {
            Value::Map(entries) => Ok(Fields { entries, what }),
            _ => Err(TuiError::bad_argument(format!("{what}: expected a map"))),
        }
    }

    fn take(&mut self, key: &str) -> Option<Value> {
        let i = self.entries.iter().position(|(k, _)| k == key)?;
        Some(self.entries.remove(i).1)
    }

    fn missing(&self, key: &str) -> TuiError {
        TuiError::bad_argument(format!("{}: missing `{key}`", self.what))
    }

    fn wrong(&self, key: &str, ty: &str) -> TuiError {
        TuiError::bad_argument(format!("{}: `{key}` must be {ty}", self.what))
    }

    fn opt_int(&mut self, key: &str) -> Result<Option<i64>, TuiError> {
        match self.take(key) {
            None => Ok(None),
            Some(Value::Int(n)) => Ok(Some(n)),
            Some(_) => Err(self.wrong(key, "an int")),
        }
    }

    fn int(&mut self, key: &str) -> Result<i64, TuiError> {
        self.opt_int(key)?.ok_or_else(|| self.missing(key))
    }

    fn opt_text(&mut self, key: &str) -> Result<Option<String>, TuiError> {
        match self.take(key) {
            None => Ok(None),
            Some(Value::Text(s)) => Ok(Some(s)),
            Some(_) => Err(self.wrong(key, "text")),
        }
    }

    fn text(&mut self, key: &str) -> Result<String, TuiError> {
        self.opt_text(key)?.ok_or_else(|| self.missing(key))
    }

    fn opt_bool(&mut self, key: &str) -> Result<Option<bool>, TuiError> {
        match self.take(key) {
            None => Ok(None),
            Some(Value::Bool(b)) => Ok(Some(b)),
            Some(_) => Err(self.wrong(key, "a bool")),
        }
    }

    fn bool(&mut self, key: &str) -> Result<bool, TuiError> {
        self.opt_bool(key)?.ok_or_else(|| self.missing(key))
    }

    fn opt_array(&mut self, key: &str) -> Result<Option<Vec<Value>>, TuiError> {
        match self.take(key) {
            None => Ok(None),
            Some(Value::Array(a)) => Ok(Some(a)),
            Some(_) => Err(self.wrong(key, "an array")),
        }
    }

    fn array(&mut self, key: &str) -> Result<Vec<Value>, TuiError> {
        self.opt_array(key)?.ok_or_else(|| self.missing(key))
    }

    fn opt_map(&mut self, key: &str, what: &'static str) -> Result<Option<Fields>, TuiError> {
        match self.take(key) {
            None => Ok(None),
            Some(v @ Value::Map(_)) => Ok(Some(Fields::from_value(v, what)?)),
            Some(_) => Err(self.wrong(key, "a map")),
        }
    }

    /// Reject any key the decoder did not consume.
    fn finish(self) -> Result<(), TuiError> {
        match self.entries.first() {
            None => Ok(()),
            Some((k, _)) => Err(TuiError::bad_argument(format!("{}: unexpected key `{k}`", self.what))),
        }
    }
}

fn color_value(c: &TuiColor) -> Value {
    match c {
        TuiColor::Index(n) => Value::Int(*n),
        TuiColor::Rgb(s) => Value::Text(s.clone()),
    }
}

fn decode_color(f: &mut Fields, key: &str) -> Result<Option<TuiColor>, TuiError> {
    match f.take(key) {
        None => Ok(None),
        Some(Value::Int(n)) if (0..=255).contains(&n) => Ok(Some(TuiColor::Index(n))),
        Some(Value::Text(s))
            if s.len() == 7 && s.starts_with('#') && s[1..].bytes().all(|b| b.is_ascii_hexdigit()) =>
        {
            Ok(Some(TuiColor::Rgb(s)))
        }
        Some(_) => Err(f.wrong(key, "a palette index 0-255 or #rrggbb")),
    }
}

fn attrs_value(a: &TuiAttrs) -> Value {
    let mut m = Vec::new();
    if let Some(c) = &a.fg {
        m.push(("fg".to_string(), color_value(c)));
    }
    if let Some(c) = &a.bg {
        m.push(("bg".to_string(), color_value(c)));
    }
    for (k, b) in [
        ("bold", a.bold),
        ("italic", a.italic),
        ("underline", a.underline),
        ("reverse", a.reverse),
        ("strike", a.strike),
    ] {
        if let Some(b) = b {
            m.push((k.to_string(), Value::Bool(b)));
        }
    }
    Value::Map(m)
}

fn decode_attrs(mut f: Fields) -> Result<TuiAttrs, TuiError> {
    let attrs = TuiAttrs {
        fg: decode_color(&mut f, "fg")?,
        bg: decode_color(&mut f, "bg")?,
        bold: f.opt_bool("bold")?,
        italic: f.opt_bool("italic")?,
        underline: f.opt_bool("underline")?,
        reverse: f.opt_bool("reverse")?,
        strike: f.opt_bool("strike")?,
    };
    f.finish()?;
    Ok(attrs)
}

fn runs_value(runs: &[TuiRun]) -> Value {
    Value::Array(
        runs.iter()
            .map(|r| {
                Value::Map(vec![
                    ("text".to_string(), Value::Text(r.text.clone())),
                    ("attrs".to_string(), attrs_value(&r.attrs)),
                ])
            })
            .collect(),
    )
}

fn decode_runs(items: Vec<Value>) -> Result<Vec<TuiRun>, TuiError> {
    items
        .into_iter()
        .map(|v| {
            let mut f = Fields::from_value(v, "run")?;
            let text = f.text("text")?;
            let attrs = match f.opt_map("attrs", "attrs")? {
                Some(a) => decode_attrs(a)?,
                None => return Err(f.missing("attrs")),
            };
            f.finish()?;
            Ok(TuiRun { text, attrs })
        })
        .collect()
}

fn layout_hint_value(h: &TuiLayoutHint) -> Value {
    let mut m = Vec::new();
    for (k, n) in [
        ("minCols", h.min_cols),
        ("minRows", h.min_rows),
        ("preferredCols", h.preferred_cols),
        ("preferredRows", h.preferred_rows),
    ] {
        if let Some(n) = n {
            m.push((k.to_string(), Value::Int(n)));
        }
    }
    if let Some(d) = &h.dock {
        m.push(("dock".to_string(), Value::Text(d.clone())));
    }
    if let Some(p) = h.priority {
        m.push(("priority".to_string(), Value::Int(p)));
    }
    Value::Map(m)
}

/// Check the constraints `decode_tui_request` enforces on a layout
/// hint, so `TuiStore::apply` can re-check them for a direct caller.
pub fn validate_tui_layout_hint(hint: &TuiLayoutHint) -> Result<(), TuiError> {
    for (key, n) in [
        ("minCols", hint.min_cols),
        ("minRows", hint.min_rows),
        ("preferredCols", hint.preferred_cols),
        ("preferredRows", hint.preferred_rows),
    ] {
        if matches!(n, Some(n) if n < 0) {
            return Err(TuiError::bad_argument(format!("layoutHint: `{key}` must be a non-negative int")));
        }
    }
    if let Some(d) = &hint.dock {
        if !TUI_DOCKS.contains(&d.as_str()) {
            return Err(TuiError::bad_argument(format!("layoutHint: unknown dock `{d}`")));
        }
    }
    Ok(())
}

/// Check a `tui.createWindow` role.
pub fn validate_tui_window_role(role: &str) -> Result<(), TuiError> {
    if TUI_WINDOW_ROLES.contains(&role) {
        Ok(())
    } else {
        Err(TuiError::bad_argument(format!("tui.createWindow: unknown role `{role}`")))
    }
}

fn decode_layout_hint(mut f: Fields) -> Result<TuiLayoutHint, TuiError> {
    let hint = TuiLayoutHint {
        min_cols: f.opt_int("minCols")?,
        min_rows: f.opt_int("minRows")?,
        preferred_cols: f.opt_int("preferredCols")?,
        preferred_rows: f.opt_int("preferredRows")?,
        dock: f.opt_text("dock")?,
        priority: f.opt_int("priority")?,
    };
    validate_tui_layout_hint(&hint)?;
    f.finish()?;
    Ok(hint)
}

/// The verb name a request is sent under.
pub fn tui_request_verb(req: &TuiRequest) -> &'static str {
    match req {
        TuiRequest::GetScreen => "tui.getScreen",
        TuiRequest::CreateWindow { .. } => "tui.createWindow",
        TuiRequest::ConfigureWindow { .. } => "tui.configureWindow",
        TuiRequest::DestroyWindow { .. } => "tui.destroyWindow",
        TuiRequest::CreateRegion { .. } => "tui.createRegion",
        TuiRequest::DestroyRegion { .. } => "tui.destroyRegion",
        TuiRequest::SetText { .. } => "tui.setText",
        TuiRequest::AppendLines { .. } => "tui.appendLines",
    }
}

/// Encode a request payload (the worker side of the wire).
pub fn encode_tui_request(req: &TuiRequest) -> Vec<u8> {
    let int = |k: &str, n: i64| (k.to_string(), Value::Int(n));
    let text = |k: &str, s: &str| (k.to_string(), Value::Text(s.to_string()));
    let m = match req {
        TuiRequest::GetScreen => vec![],
        TuiRequest::CreateWindow { screen_id, title, role, layout_hint } => vec![
            int("screenId", *screen_id),
            text("title", title),
            text("role", role),
            ("layoutHint".to_string(), layout_hint_value(layout_hint)),
        ],
        TuiRequest::ConfigureWindow { window_id, title, layout_hint } => {
            let mut m = vec![int("windowId", *window_id)];
            if let Some(t) = title {
                m.push(text("title", t));
            }
            if let Some(h) = layout_hint {
                m.push(("layoutHint".to_string(), layout_hint_value(h)));
            }
            m
        }
        TuiRequest::DestroyWindow { window_id } => vec![int("windowId", *window_id)],
        TuiRequest::CreateRegion { window_id, role, layout_hint, scrollback } => {
            let mut m = vec![int("windowId", *window_id), text("role", role)];
            if let Some(h) = layout_hint {
                m.push(("layoutHint".to_string(), layout_hint_value(h)));
            }
            if let Some(s) = scrollback {
                m.push(int("scrollback", *s));
            }
            m
        }
        TuiRequest::DestroyRegion { region_id } => vec![int("regionId", *region_id)],
        TuiRequest::SetText { region_id, runs } => {
            vec![int("regionId", *region_id), ("runs".to_string(), runs_value(runs))]
        }
        TuiRequest::AppendLines { region_id, lines } => vec![
            int("regionId", *region_id),
            ("lines".to_string(), Value::Array(lines.iter().map(|l| runs_value(l)).collect())),
        ],
    };
    encode_value(&Value::Map(m))
}

/// Decode a request payload for `verb`. An unknown `tui.*` verb, a
/// missing required key, a wrong-typed value, or an unexpected key all
/// decode to `bad-argument`.
pub fn decode_tui_request(verb: &str, data: &[u8]) -> Result<TuiRequest, TuiError> {
    let mut f = decode_map(data)?;
    let req = match verb {
        "tui.getScreen" => TuiRequest::GetScreen,
        "tui.createWindow" => {
            if f.take("initialRegions").is_some() {
                return Err(TuiError::bad_argument("tui.createWindow: `initialRegions` is not supported yet"));
            }
            let screen_id = f.int("screenId")?;
            let title = f.text("title")?;
            let role = f.text("role")?;
            validate_tui_window_role(&role)?;
            let layout_hint = match f.opt_map("layoutHint", "layoutHint")? {
                Some(h) => decode_layout_hint(h)?,
                None => return Err(f.missing("layoutHint")),
            };
            TuiRequest::CreateWindow { screen_id, title, role, layout_hint }
        }
        "tui.configureWindow" => TuiRequest::ConfigureWindow {
            window_id: f.int("windowId")?,
            title: f.opt_text("title")?,
            layout_hint: f.opt_map("layoutHint", "layoutHint")?.map(decode_layout_hint).transpose()?,
        },
        "tui.destroyWindow" => TuiRequest::DestroyWindow { window_id: f.int("windowId")? },
        "tui.createRegion" => {
            let window_id = f.int("windowId")?;
            let role = f.text("role")?;
            if !TUI_REGION_ROLES.contains(&role.as_str()) {
                return Err(TuiError::bad_argument(format!("tui.createRegion: unknown role `{role}`")));
            }
            TuiRequest::CreateRegion {
                window_id,
                role,
                layout_hint: f.opt_map("layoutHint", "layoutHint")?.map(decode_layout_hint).transpose()?,
                scrollback: f.opt_int("scrollback")?,
            }
        }
        "tui.destroyRegion" => TuiRequest::DestroyRegion { region_id: f.int("regionId")? },
        "tui.setText" => TuiRequest::SetText { region_id: f.int("regionId")?, runs: decode_runs(f.array("runs")?)? },
        "tui.appendLines" => {
            let region_id = f.int("regionId")?;
            let lines = f
                .array("lines")?
                .into_iter()
                .map(|l| match l {
                    Value::Array(runs) => decode_runs(runs),
                    _ => Err(TuiError::bad_argument("tui.appendLines: each line must be an array of runs")),
                })
                .collect::<Result<_, _>>()?;
            TuiRequest::AppendLines { region_id, lines }
        }
        other => return Err(TuiError::bad_argument(format!("unknown verb `{other}`"))),
    };
    f.finish()?;
    Ok(req)
}

/// Encode a success reply payload (the daemon side of the wire).
pub fn encode_tui_reply(reply: &TuiReply) -> Vec<u8> {
    let int = |k: &str, n: i64| (k.to_string(), Value::Int(n));
    let boolean = |k: &str, b: bool| (k.to_string(), Value::Bool(b));
    let m = match reply {
        TuiReply::Screen { screen_id, cols, rows, color_depth, has_mouse, has_focus, attached } => vec![
            int("screenId", *screen_id),
            int("cols", *cols),
            int("rows", *rows),
            int("colorDepth", *color_depth),
            boolean("hasMouse", *has_mouse),
            boolean("hasFocus", *has_focus),
            boolean("attached", *attached),
        ],
        TuiReply::Window { window_id } => vec![int("windowId", *window_id)],
        TuiReply::Region { region_id } => vec![int("regionId", *region_id)],
        TuiReply::Appended { first_line, last_line } => {
            vec![int("firstLine", *first_line), int("lastLine", *last_line)]
        }
        TuiReply::Empty => vec![],
    };
    encode_value(&Value::Map(m))
}

/// Decode the success reply to `verb`.
pub fn decode_tui_reply(verb: &str, data: &[u8]) -> Result<TuiReply, TuiError> {
    let mut f = decode_map(data)?;
    let reply = match verb {
        "tui.getScreen" => TuiReply::Screen {
            screen_id: f.int("screenId")?,
            cols: f.int("cols")?,
            rows: f.int("rows")?,
            color_depth: f.int("colorDepth")?,
            has_mouse: f.bool("hasMouse")?,
            has_focus: f.bool("hasFocus")?,
            attached: f.bool("attached")?,
        },
        "tui.createWindow" => TuiReply::Window { window_id: f.int("windowId")? },
        "tui.createRegion" => TuiReply::Region { region_id: f.int("regionId")? },
        "tui.appendLines" => TuiReply::Appended { first_line: f.int("firstLine")?, last_line: f.int("lastLine")? },
        "tui.configureWindow" | "tui.destroyWindow" | "tui.destroyRegion" | "tui.setText" => TuiReply::Empty,
        other => return Err(TuiError::bad_argument(format!("unknown verb `{other}`"))),
    };
    f.finish()?;
    Ok(reply)
}

/// Encode the `{ code, message }` payload of an `error` reply.
pub fn encode_tui_error(err: &TuiError) -> Vec<u8> {
    encode_value(&Value::Map(vec![
        ("code".to_string(), Value::Text(err.code.as_str().to_string())),
        ("message".to_string(), Value::Text(err.message.clone())),
    ]))
}

/// Decode the `{ code, message }` payload of an `error` reply.
pub fn decode_tui_error(data: &[u8]) -> Result<TuiError, TuiError> {
    let mut f = decode_map(data)?;
    let code = f.text("code")?;
    let code = TuiErrorCode::parse(&code).ok_or_else(|| TuiError::bad_argument(format!("unknown code `{code}`")))?;
    let message = f.text("message")?;
    f.finish()?;
    Ok(TuiError { code, message })
}

#[cfg(test)]
mod tui_tests {
    use super::*;

    fn hint() -> TuiLayoutHint {
        TuiLayoutHint {
            min_cols: Some(10),
            min_rows: Some(1),
            preferred_cols: Some(40),
            preferred_rows: Some(3),
            dock: Some("bottom".into()),
            priority: Some(-2),
        }
    }

    fn runs() -> Vec<TuiRun> {
        vec![
            TuiRun {
                text: "warn".into(),
                attrs: TuiAttrs {
                    fg: Some(TuiColor::Index(3)),
                    bg: Some(TuiColor::Rgb("#102030".into())),
                    bold: Some(true),
                    italic: Some(false),
                    underline: Some(true),
                    reverse: Some(false),
                    strike: Some(true),
                },
            },
            TuiRun { text: " plain".into(), attrs: TuiAttrs::default() },
        ]
    }

    #[test]
    fn requests_round_trip() {
        let reqs = vec![
            TuiRequest::GetScreen,
            TuiRequest::CreateWindow { screen_id: 1, title: "t".into(), role: "log".into(), layout_hint: hint() },
            TuiRequest::CreateWindow {
                screen_id: 1,
                title: "".into(),
                role: "chat".into(),
                layout_hint: TuiLayoutHint::default(),
            },
            TuiRequest::ConfigureWindow { window_id: 2, title: Some("u".into()), layout_hint: Some(hint()) },
            TuiRequest::ConfigureWindow { window_id: 2, title: None, layout_hint: None },
            TuiRequest::DestroyWindow { window_id: 2 },
            TuiRequest::CreateRegion { window_id: 2, role: "buffer".into(), layout_hint: Some(hint()), scrollback: Some(50) },
            TuiRequest::CreateRegion { window_id: 2, role: "text".into(), layout_hint: None, scrollback: None },
            TuiRequest::DestroyRegion { region_id: 3 },
            TuiRequest::SetText { region_id: 3, runs: runs() },
            TuiRequest::AppendLines { region_id: 3, lines: vec![runs(), vec![], runs()] },
        ];
        for req in reqs {
            let verb = tui_request_verb(&req);
            assert_eq!(decode_tui_request(verb, &encode_tui_request(&req)).unwrap(), req, "{verb}");
        }
    }

    #[test]
    fn replies_round_trip() {
        let cases = vec![
            (
                "tui.getScreen",
                TuiReply::Screen {
                    screen_id: 1,
                    cols: 80,
                    rows: 24,
                    color_depth: 256,
                    has_mouse: true,
                    has_focus: false,
                    attached: true,
                },
            ),
            ("tui.createWindow", TuiReply::Window { window_id: 4 }),
            ("tui.createRegion", TuiReply::Region { region_id: 5 }),
            ("tui.appendLines", TuiReply::Appended { first_line: 6, last_line: 9 }),
            ("tui.configureWindow", TuiReply::Empty),
            ("tui.destroyWindow", TuiReply::Empty),
            ("tui.destroyRegion", TuiReply::Empty),
            ("tui.setText", TuiReply::Empty),
        ];
        for (verb, reply) in cases {
            assert_eq!(decode_tui_reply(verb, &encode_tui_reply(&reply)).unwrap(), reply, "{verb}");
        }
    }

    #[test]
    fn error_round_trips() {
        let err = TuiError::new(TuiErrorCode::TooLarge, "big");
        assert_eq!(decode_tui_error(&encode_tui_error(&err)).unwrap(), err);
    }

    fn bad(verb: &str, m: Vec<(&str, Value)>) {
        let payload = encode_value(&Value::Map(m.into_iter().map(|(k, v)| (k.to_string(), v)).collect()));
        let err = decode_tui_request(verb, &payload).unwrap_err();
        assert_eq!(err.code, TuiErrorCode::BadArgument, "{verb}: {}", err.message);
    }

    #[test]
    fn missing_or_wrong_typed_keys_are_bad_argument() {
        let t = |s: &str| Value::Text(s.into());
        bad("tui.destroyWindow", vec![]);
        bad("tui.destroyWindow", vec![("windowId", t("1"))]);
        bad("tui.destroyRegion", vec![("regionId", Value::Bool(true))]);
        bad("tui.createWindow", vec![("screenId", Value::Int(1)), ("title", t("x")), ("role", t("log"))]);
        bad(
            "tui.createWindow",
            vec![("screenId", Value::Int(1)), ("title", t("x")), ("role", t("nope")), ("layoutHint", Value::Map(vec![]))],
        );
        bad(
            "tui.createWindow",
            vec![
                ("screenId", Value::Int(1)),
                ("title", t("x")),
                ("role", t("log")),
                ("layoutHint", Value::Map(vec![("dock".into(), t("middle"))])),
            ],
        );
        bad(
            "tui.createWindow",
            vec![
                ("screenId", Value::Int(1)),
                ("title", t("x")),
                ("role", t("log")),
                ("layoutHint", Value::Map(vec![])),
                ("initialRegions", Value::Array(vec![])),
            ],
        );
        bad("tui.createRegion", vec![("windowId", Value::Int(1)), ("role", t("pane"))]);
        bad("tui.createRegion", vec![("windowId", Value::Int(1)), ("role", t("buffer")), ("scrollback", t("9"))]);
        bad("tui.setText", vec![("regionId", Value::Int(1))]);
        bad("tui.setText", vec![("regionId", Value::Int(1)), ("runs", Value::Array(vec![t("bare")]))]);
        bad(
            "tui.setText",
            vec![
                ("regionId", Value::Int(1)),
                ("runs", Value::Array(vec![Value::Map(vec![("text".into(), t("x"))])])),
            ],
        );
        bad(
            "tui.setText",
            vec![
                ("regionId", Value::Int(1)),
                (
                    "runs",
                    Value::Array(vec![Value::Map(vec![
                        ("text".into(), t("x")),
                        ("attrs".into(), Value::Map(vec![("fg".into(), t("red"))])),
                    ])]),
                ),
            ],
        );
        bad("tui.appendLines", vec![("regionId", Value::Int(1)), ("lines", Value::Array(vec![t("x")]))]);
        bad("tui.destroyWindow", vec![("windowId", Value::Int(1)), ("extra", Value::Int(2))]);
        bad("tui.unknown", vec![]);
        assert_eq!(decode_tui_request("tui.getScreen", &[0xff]).unwrap_err().code, TuiErrorCode::BadArgument);
        assert_eq!(decode_tui_request("tui.getScreen", &[0xa0, 0x00]).unwrap_err().code, TuiErrorCode::BadArgument);
        assert!(decode_tui_reply("tui.createWindow", &encode_tui_reply(&TuiReply::Empty)).is_err());
    }

    #[test]
    fn oversized_map_is_bad_argument() {
        // A map head claiming many entries is refused before any key is read.
        let mut payload = Vec::new();
        cbor_append_head(&mut payload, CBOR_MAP, TUI_MAX_MAP_ENTRIES + 1);
        for i in 0..=TUI_MAX_MAP_ENTRIES {
            cbor_append_text(&mut payload, &format!("k{i}"));
            cbor_append_int(&mut payload, 0);
        }
        let err = decode_tui_request("tui.getScreen", &payload).unwrap_err();
        assert_eq!(err.code, TuiErrorCode::BadArgument);
        let mut payload = Vec::new();
        cbor_append_head(&mut payload, CBOR_MAP, u64::MAX);
        assert_eq!(decode_tui_request("tui.getScreen", &payload).unwrap_err().code, TuiErrorCode::BadArgument);
    }

    #[test]
    fn out_of_range_ints_are_bad_argument() {
        for major in [CBOR_UINT, CBOR_NEGINT] {
            for value in [1u64 << 63, u64::MAX] {
                let mut payload = Vec::new();
                cbor_append_head(&mut payload, CBOR_MAP, 1);
                cbor_append_text(&mut payload, "regionId");
                cbor_append_head(&mut payload, major, value);
                let err = decode_tui_request("tui.destroyRegion", &payload).unwrap_err();
                assert_eq!(err.code, TuiErrorCode::BadArgument, "major {major} value {value}");
            }
        }
        let mut payload = Vec::new();
        cbor_append_head(&mut payload, CBOR_MAP, 1);
        cbor_append_text(&mut payload, "regionId");
        cbor_append_head(&mut payload, CBOR_NEGINT, i64::MAX as u64);
        assert_eq!(
            decode_tui_request("tui.destroyRegion", &payload).unwrap(),
            TuiRequest::DestroyRegion { region_id: i64::MIN }
        );
    }

    #[test]
    fn huge_text_length_is_bad_argument() {
        let mut payload = Vec::new();
        cbor_append_head(&mut payload, CBOR_MAP, 1);
        cbor_append_head(&mut payload, CBOR_TEXT, u64::MAX);
        assert_eq!(decode_tui_request("tui.getScreen", &payload).unwrap_err().code, TuiErrorCode::BadArgument);
    }
}
