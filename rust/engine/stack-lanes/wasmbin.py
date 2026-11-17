"""A small reader for the parts of a wasm binary lane C needs: the function
names from the "name" custom section, the number of imported functions (so
code-section indices map to function indices), and each function's shadow-stack
prologue, `global.get $sp; i32.const N; i32.sub`, whose N is the frame the
function reserves in linear memory.
"""
import struct


def leb_u(data, pos):
    result = shift = 0
    while True:
        byte = data[pos]
        pos += 1
        result |= (byte & 0x7F) << shift
        if byte < 0x80:
            return result, pos
        shift += 7


def leb_s32(data, pos):
    result = shift = 0
    while True:
        byte = data[pos]
        pos += 1
        result |= (byte & 0x7F) << shift
        shift += 7
        if byte < 0x80:
            if shift < 32 and byte & 0x40:
                result |= -1 << shift
            return result, pos


def sections(data):
    assert data[:8] == b"\0asm\x01\0\0\0", "not a wasm binary"
    pos = 8
    while pos < len(data):
        kind = data[pos]
        size, pos = leb_u(data, pos + 1)
        yield kind, data[pos:pos + size]
        pos += size


def import_function_count(section):
    count, pos = leb_u(section, 0)
    functions = 0
    for _ in range(count):
        n, pos = leb_u(section, pos)
        pos += n
        n, pos = leb_u(section, pos)
        pos += n
        kind = section[pos]
        pos += 1
        if kind == 0:
            _, pos = leb_u(section, pos)
            functions += 1
        elif kind == 1:
            pos += 1  # reftype
            flags = section[pos]
            pos += 1
            _, pos = leb_u(section, pos)
            if flags & 1:
                _, pos = leb_u(section, pos)
        elif kind == 2:
            flags = section[pos]
            pos += 1
            _, pos = leb_u(section, pos)
            if flags & 1:
                _, pos = leb_u(section, pos)
        elif kind == 3:
            pos += 2
        elif kind == 4:
            pos += 1
            _, pos = leb_u(section, pos)
        else:
            raise ValueError(f"unknown import kind {kind}")
    return functions


def function_names(section):
    """The function-name subsection of a "name" custom section: index -> name."""
    n, pos = leb_u(section, 0)
    if section[pos:pos + n] != b"name":
        return None
    pos += n
    names = {}
    while pos < len(section):
        sub = section[pos]
        size, pos = leb_u(section, pos + 1)
        if sub == 1:
            count, p = leb_u(section, pos)
            for _ in range(count):
                index, p = leb_u(section, p)
                length, p = leb_u(section, p)
                names[index] = section[p:p + length].decode("utf-8", "replace")
                p += length
        pos += size
    return names


SP_GLOBAL = 0  # the shadow stack pointer is the module's first global


def leb_u_bytes(n):
    out = bytearray()
    while True:
        byte = n & 0x7F
        n >>= 7
        if n:
            out.append(byte | 0x80)
        else:
            out.append(byte)
            return bytes(out)


def is_sp(body, pos):
    """Whether the global index at `pos` (LEB, possibly padded to five bytes
    for relocation) is the shadow stack pointer's; returns the end position."""
    index, end = leb_u(body, pos)
    return index == SP_GLOBAL, end


def shadow_prologue(body):
    """The bytes a function body reserves on the shadow stack: 0 when it
    reserves nothing, None when it moves the stack pointer in a way this
    reader does not understand. After the locals, LLVM opens a frame with
    `global.get $sp; i32.const N; i32.sub` (possibly inside a leading
    `block`/`loop`, and `global.get $sp` may first be copied to a local). A
    body that only saves `$sp` to a local at entry reserves later, on some
    path, as `local.get L; i32.const N; i32.sub`; the largest such N is its
    frame. A body that writes `$sp` back without any reservation found is
    not understood."""
    count, pos = leb_u(body, 0)
    for _ in range(count):
        _, pos = leb_u(body, pos)
        pos += 1
    saved = None  # the local `$sp` was copied to at entry
    for _ in range(4):
        op = body[pos] if pos < len(body) else None
        if op in (0x02, 0x03):  # block, loop: skip the block type
            _, pos = leb_s32(body, pos + 1)
            continue
        if op == 0x23:  # global.get
            sp, p = is_sp(body, pos + 1)
            if not sp:
                break
            if body[p] == 0x41:
                n, p = leb_s32(body, p + 1)
                if body[p] == 0x6B:
                    return n
            elif body[p] in (0x21, 0x22):  # local.set/tee
                saved, p = leb_u(body, p + 1)
                if body[p] == 0x41:
                    n, p = leb_s32(body, p + 1)
                    if body[p] == 0x6B:
                        return n
        break
    sets = sp_writes(body)
    if saved is None:
        return None if sets else 0
    # `local.get saved; i32.const N; i32.sub`, wherever the reservation is.
    pattern = b"\x20" + leb_u_bytes(saved) + b"\x41"
    largest = None
    start = 0
    while True:
        at = body.find(pattern, start)
        if at < 0:
            break
        n, p = leb_s32(body, at + len(pattern))
        if p < len(body) and body[p] == 0x6B and n > 0:
            largest = n if largest is None else max(largest, n)
        start = at + 1
    if largest is not None:
        return largest
    # A body that only writes the saved value back (`local.get saved;
    # global.set $sp`, restoring after a caught exception) reserves nothing.
    restore = b"\x20" + leb_u_bytes(saved)
    if all(body[at - len(restore):at] == restore for at in sets):
        return 0
    return None


def sp_writes(body):
    """Positions of every `global.set $sp` in a body, padded index or not."""
    positions = []
    for encoded in (b"\x24" + leb_u_bytes(SP_GLOBAL), b"\x24\x80\x80\x80\x80\x00"):
        start = 0
        while True:
            at = body.find(encoded, start)
            if at < 0:
                break
            positions.append(at)
            start = at + 1
    return sorted(set(positions))


def read(path):
    """names (index -> name), imports (count) and shadow frames (index -> bytes,
    or None for a body whose stack-pointer moves are not understood)."""
    data = open(path, "rb").read()
    names = None
    imports = 0
    frames = {}
    for kind, section in sections(data):
        if kind == 0:
            found = function_names(section)
            if found is not None:
                names = found
        elif kind == 2:
            imports = import_function_count(section)
        elif kind == 10:
            count, pos = leb_u(section, 0)
            for i in range(count):
                size, pos = leb_u(section, pos)
                frames[imports + i] = shadow_prologue(section[pos:pos + size])
                pos += size
    return names or {}, imports, frames
