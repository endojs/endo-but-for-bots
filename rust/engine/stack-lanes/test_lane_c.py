import contextlib
import io
import unittest
from unittest import mock

import common
import lane_c
import wasmbin

DISPATCH = "ironhorse_vm::interp::dispatch::<impl ironhorse_vm::interp::Interp>::dispatch_at_inner"


class Names(unittest.TestCase):
    def test_the_three_spellings_of_one_function_agree(self):
        mangled = ("_ZN12ironhorse_vm6interp8dispatch46_$LT$impl$u20$ironhorse_vm..interp..Interp$GT$"
                   "17dispatch_at_inner17h5d810fa030902413E")
        readobj = ("ironhorse_vm::interp::dispatch::_$LT$impl$u20$ironhorse_vm..interp..Interp$GT$"
                   "::dispatch_at_inner::h43be05dfe16c4640")
        demangled = DISPATCH + "::h43be05dfe16c4640"
        for spelling in (mangled, readobj, demangled):
            self.assertEqual(lane_c.canonical(spelling), DISPATCH)

    def test_an_internalized_copy_shares_the_name(self):
        self.assertEqual(lane_c.canonical("_ZN4core3ptr47drop_in_place$LT$ironhorse_vm..interp..Halt$GT$"
                                          "17hab1161ddbfbd6763E.llvm.848891875"),
                         "core::ptr::drop_in_place<ironhorse_vm::interp::Halt>")
        # llvm-readobj's spelling of the same mark, after the hash.
        self.assertEqual(lane_c.canonical("core::ops::function::FnOnce::call_once$u7b$$u7b$vtable.shim$u7d$$u7d$"
                                          "::h30ec0f866bbf4528 (.llvm.11408211452632768118)"),
                         "core::ops::function::FnOnce::call_once{{vtable.shim}}")

    def test_parenthesised_generics_are_unescaped(self):
        self.assertEqual(lane_c.canonical("_ZN1a27Extend$LT$$LP$K$C$V$RP$$GT$17h0000000000000001E"), "a::Extend<(K,V)>")

    def test_a_v0_or_plain_name_passes_through(self):
        self.assertEqual(lane_c.canonical("__wasm_call_ctors"), "__wasm_call_ctors")
        self.assertEqual(lane_c.canonical("_RNvCskdKJRKLKjqM_7___rustc42___rust_alloc_error_handler_should_panic_v2"),
                         "_RNvCskdKJRKLKjqM_7___rustc42___rust_alloc_error_handler_should_panic_v2")


class NativeFrames(unittest.TestCase):
    TEXT = """File: libironhorse_vm.rlib(lib.rmeta)
StackSizes [
]
File: libironhorse_vm.rlib(ironhorse_vm.o)
StackSizes [
  Entry {
    Functions: [ironhorse_vm::interp::dispatch::_$LT$impl$u20$ironhorse_vm..interp..Interp$GT$::dispatch_at_inner::h43be05dfe16c4640]
    Size: 0x11E8
  }
  Entry {
    Functions: [a::one::h0000000000000001, a::two::h0000000000000002]
    Size: 0x10
  }
  Entry {
    Functions: [a::one::h0000000000000003]
    Size: 0x8
  }
]
"""

    def test_sizes_count_the_return_address(self):
        frames = lane_c.parse_stack_sizes(self.TEXT)
        self.assertEqual(frames[DISPATCH], 0x11E8 + 8)

    def test_aliases_share_a_size_and_duplicates_keep_the_largest(self):
        frames = lane_c.parse_stack_sizes(self.TEXT)
        self.assertEqual(frames["a::two"], 24)
        self.assertEqual(frames["a::one"], 24)


class CraneliftFrames(unittest.TestCase):
    TEXT = """
000000000032c880 <wasm[0]::function[865]::_ZN12ironhorse_vm6interp8dispatch46_$LT$impl$u20$ironhorse_vm..interp..Interp$GT$17dispatch_at_i>:
  32c880:	push   %rbp
  32c881:	mov    %rsp,%rbp
  32c884:	mov    0x8(%rdi),%r10
  32c888:	mov    0x18(%r10),%r10
  32c88c:	add    $0x2a50,%r10
  32c893:	cmp    %rsp,%r10
  32c896:	ja     3d70ee <wasm[0]::function[865]::_ZN12ironhorse_vm6interp8dispatch46_+0xaa86e>
  32c89c:	sub    $0x1000,%rsp
  32c8a3:	movl   $0x0,(%rsp)
  32c8aa:	sub    $0x1000,%rsp
  32c8b1:	movl   $0x0,(%rsp)
  32c8b8:	add    $0x2000,%rsp
  32c8bf:	sub    $0x2a40,%rsp
  32c8c6:	mov    %rbx,0x2a10(%rsp)
  32c8ee:	sub    $0x10,%rsp
  32c8f3:	call   32c880 <wasm[0]::function[865]::_ZN12ironhorse_vm6interp8dispatch46_>
0000000000000000 <wasm[0]::function[8]::__wasm_call_ctors>:
       0:	push   %rbp
       1:	mov    %rsp,%rbp
       4:	mov    %rbp,%rsp
       7:	pop    %rbp
       8:	ret
	...
000000000009c1e0 <wasm[0]::function[9]::leaf_with_a_slot>:
   9c1e0:	push   %rbp
   9c1e1:	mov    %rsp,%rbp
   9c1e4:	sub    $0x20,%rsp
   9c1e8:	mov    %rbx,0x10(%rsp)
   9c1ec:	sub    $0x8,%rsp
   9c1f0:	call   0 <wasm[0]::function[8]::__wasm_call_ctors>
   9c1f5:	sub    $0x100,%rsp
000000000009c200 <wasm[0]::trampoline[9]::array_to_wasm>:
   9c200:	push   %rbp
   9c201:	sub    $0x40,%rsp
   9c205:	add    $0x50,%r10
   9c209:	cmp    %rsp,%r10
"""

    def test_the_stack_check_constant_is_the_frame(self):
        frames = lane_c.parse_cranelift(self.TEXT)
        self.assertEqual(frames[865], 0x2a50)

    def test_a_leaf_without_a_check_is_the_pushed_frame_pointer(self):
        frames = lane_c.parse_cranelift(self.TEXT)
        self.assertEqual(frames[8], 16)

    def test_without_a_check_the_prologue_reservations_are_summed_until_the_first_call(self):
        frames = lane_c.parse_cranelift(self.TEXT)
        self.assertEqual(frames[9], 16 + 0x20 + 0x8)

    def test_a_trampoline_is_not_a_function(self):
        self.assertEqual(set(lane_c.parse_cranelift(self.TEXT)), {865, 8, 9})


class V8Frames(unittest.TestCase):
    TEXT = """--- WebAssembly code ---
name: _ZN1a3big17h0000000000000001E
index: 865
kind: wasm function
compiler: TurboFan
Body (size = 289792 = 289792 + 0 padding)
Instructions (size = 271288)
0x16c5ba085940     0  55                   push rbp
0x16c5ba085941     1  4889e5               REX.W movq rbp,rsp
0x16c5ba085944     4  6a08                 push 0x8
0x16c5ba085946     6  56                   push rsi
0x16c5ba085947     7  4881ec30030000       REX.W subq rsp,0x330
0x16c5ba08594e     e  488995f8feffff       REX.W movq [rbp-0x108],rdx
0x16c5ba085964    24  493b65a0             REX.W cmpq rsp,[r13-0x60]
0x16c5ba085968    28  0f8689d40300         jna 0x16c5ba0c2df7  <+0x3d4b7>
0x16c5ba08594e     e  4881ec30030000       REX.W subq rsp,0x8

--- End code ---
--- WebAssembly code ---
name: __wasm_call_ctors
index: 8
kind: wasm function
compiler: TurboFan
Body (size = 64 = 24 + 40 padding)
Instructions (size = 16)
0x16c5ba3f34c0     0  55                   push rbp
0x16c5ba3f34c1     1  4889e5               REX.W movq rbp,rsp
0x16c5ba3f34c4     4  6a08                 push 0x8
0x16c5ba3f34c6     6  56                   push rsi
0x16c5ba3f34c7     7  488be5               REX.W movq rsp,rbp
0x16c5ba3f34ca     a  5d                   pop rbp
0x16c5ba3f34cb     b  c3                   retl

--- End code ---
--- WebAssembly code ---
name: _ZN1a5other17h0000000000000002E
index: 9
kind: wasm function
compiler: Liftoff
Body (size = 64 = 24 + 40 padding)
Instructions (size = 16)
0x16c5ba3f34c0     0  55                   push rbp
0x16c5ba3f34c7     7  4881ec30030000       REX.W subq rsp,0x40

--- End code ---
--- WebAssembly code ---
name: _ZN1a9big_liftoff17h0000000000000003E
index: 10
kind: wasm function
compiler: TurboFan
Body (size = 64 = 24 + 40 padding)
Instructions (size = 16)
0x16c5ba3f34c0     0  55                   push rbp
0x16c5ba3f34c1     1  4889e5               REX.W movq rbp,rsp
0x16c5ba3f34c4     4  6a08                 push 0x8
0x16c5ba3f34c6     6  56                   push rsi
0x16c5ba3f34c7     7  e9a0000000           jmp 0x16c5ba3f3570  <+0xb0>
0x16c5ba3f34cc     c  4c8b5e3f             REX.W movq r11,[rsi+0x3f]
0x16c5ba3f3570    b0  4881ec00100000       REX.W subq rsp,0x1000
0x16c5ba3f3577    b7  e950ffffff           jmp 0x16c5ba3f34cc  <+0xc>

--- End code ---
--- WebAssembly code ---
name: _ZN1a12big_turbofan17h0000000000000004E
index: 11
kind: wasm function
compiler: TurboFan
Body (size = 64 = 24 + 40 padding)
Instructions (size = 16)
0x16c5ba3f34c0     0  55                   push rbp
0x16c5ba3f34c1     1  4889e5               REX.W movq rbp,rsp
0x16c5ba3f34c4     4  6a08                 push 0x8
0x16c5ba3f34c6     6  56                   push rsi
0x16c5ba3f34c7     7  498b45a0             REX.W movq rax,[r13-0x60]
0x16c5ba3f34cb     b  4805002000           REX.W addq rax,0x2000
0x16c5ba3f34d1    11  483bc4               REX.W cmpq rsp,rax
0x16c5ba3f34d4    14  7305                 jnc 0x16c5ba3f34db  <+0x1b>
0x16c5ba3f34d6    16  e8a5f0ffff           call 0x16c5ba3f2580  (WasmStackOverflow)
0x16c5ba3f34db    1b  4881ec00200000       REX.W subq rsp,0x2000
0x16c5ba3f34e2    22  50                   push rax

--- End code ---
"""

    def test_the_return_address_pushes_and_reservation_are_summed(self):
        frames, other = lane_c.parse_v8(self.TEXT, "TurboFan")
        self.assertEqual(frames[865], 8 + 3 * 8 + 0x330)

    def test_a_leaf_that_returns_without_reserving_counts_its_pushes(self):
        frames, other = lane_c.parse_v8(self.TEXT, "TurboFan")
        self.assertEqual(frames[8], 8 + 3 * 8)

    def test_a_function_another_tier_compiled_is_kept_apart(self):
        frames, other = lane_c.parse_v8(self.TEXT, "TurboFan")
        self.assertNotIn(9, frames)
        self.assertEqual(other[9], 8 + 8 + 0x40)

    def test_a_large_frame_reserved_out_of_line_or_after_a_stack_check_is_found(self):
        frames, _ = lane_c.parse_v8(self.TEXT, "TurboFan")
        self.assertEqual(frames[10], 8 + 3 * 8 + 0x1000)
        self.assertEqual(frames[11], 8 + 3 * 8 + 0x2000)


class ByName(unittest.TestCase):
    def test_internalized_copies_merge_to_the_largest(self):
        names = {1: "_ZN1a1f17h0000000000000001E", 2: "_ZN1a1f17h0000000000000002E.llvm.5", 3: "g"}
        self.assertEqual(lane_c.by_name(names, {1: 16, 2: 48, 3: 8}), {"a::f": 48, "g": 8})

    def test_an_unnamed_function_is_keyed_by_index(self):
        self.assertEqual(lane_c.by_name({}, {7: 16}), {"function[7]": 16})


class Chains(unittest.TestCase):
    def test_the_period_is_the_shortest_repeat(self):
        self.assertEqual(lane_c.one_level(list("abcabcabcabc")), list("abc"))
        self.assertEqual(lane_c.one_level(list("aaaaaaaa")), ["a"])

    def test_one_level_skips_the_trap_site_and_stops_at_the_entry_frames(self):
        names = ["leaf", "leaf2"] + ["x::run_user_callback", DISPATCH, "x::invoke_value"] * 5 + ["main", "_start"]
        self.assertEqual(lane_c.one_level(names), [DISPATCH, "x::invoke_value", "x::run_user_callback"])

    def test_one_level_over_indices_rotates_by_name(self):
        names = {1: "x::run_user_callback", 2: "_ZN1a17dispatch_at_innerE", 3: "x::invoke_value"}
        level = lane_c.one_level([9, 1, 2, 3] * 4 + [7], name=lambda i: lane_c.function_name(names, i))
        self.assertEqual(level, [2, 3, 9, 1])

    def test_one_level_needs_four_repeats(self):
        names = ["leaf"] + ["a", "b"] * 3 + ["main"]
        self.assertIsNone(lane_c.one_level(names))
        self.assertEqual(lane_c.one_level(["leaf"] + ["a", "b"] * 4 + ["main"]), ["a", "b"])

    def test_units_per_level_follow_from_the_ceiling(self):
        self.assertEqual(lane_c.units_per_level(63), 32)
        self.assertEqual(lane_c.units_per_level(126), 16)
        self.assertEqual(lane_c.units_per_level(42), 48)


TIMEOUT = common.Outcome(trap="timeout after 900s", timed_out=True)


def native_mark(probe, args, **kwargs):
    """The native probe's --stack line for a family at depth args[3]."""
    return common.Outcome(line=f'halt=Return result="x" meter=1 stack={int(args[3]) * 100}')


def shadow_mark(wasm, args, **kwargs):
    """A painting Node run of a family at depth args[3] that returned."""
    outcome = common.Outcome(line='halt=Return result="x" meter=1')
    outcome.shadow_stack = int(args[3]) * 10
    return outcome


class Slopes(unittest.TestCase):
    def slopes(self, native=native_mark, node=shadow_mark):
        """lane_c.slopes over one heavy family at ceiling 126, its painters'
        hosts replaced: the family's entry and the run's problems."""
        problems = []
        with mock.patch.object(lane_c.ceilings, "recorded", return_value=[("valueOf", 126)]), \
                mock.patch.object(common, "run_native", side_effect=native), \
                mock.patch.object(common, "run_node", side_effect=node), \
                contextlib.redirect_stdout(io.StringIO()):
            entry = lane_c.slopes("probe", "probe.wasm", problems)["valueOf"]
        return entry, problems

    def test_both_painters_give_a_slope(self):
        entry, problems = self.slopes()
        self.assertEqual(problems, [])
        self.assertEqual(entry["native"]["bytes_per_level"], 100)
        self.assertEqual(entry["shadow"]["bytes_per_level"], 10)

    def test_a_shadow_painter_timeout_is_a_problem_not_a_missing_entry(self):
        """`Outcome.trapped` excludes a timeout, which left no mark and no
        problem: the shadow slope dropped out of the report silently."""
        entry, problems = self.slopes(node=lambda *args, **kwargs: TIMEOUT)
        self.assertNotIn("shadow", entry)
        self.assertEqual(len(problems), 1)
        self.assertRegex(problems[0], r"^slope valueOf: the shadow painter timed out at depth 63\b.*"
                                      r"timeout after 900s$")

    def test_a_native_painter_timeout_or_trap_is_a_problem_not_a_missing_entry(self):
        for outcome, verdict in ((TIMEOUT, "timed out"), (common.Outcome(trap="signal 6"), "trapped")):
            with self.subTest(verdict=verdict):
                entry, problems = self.slopes(native=lambda *args, **kwargs: outcome)
                self.assertNotIn("native", entry)
                self.assertEqual(len(problems), 1)
                self.assertRegex(problems[0], rf"^slope valueOf: the native painter {verdict} at depth 63: ")

    def test_a_shadow_painter_trap_is_a_problem_not_a_missing_entry(self):
        trapped = common.Outcome(trap="TRAP: Maximum call stack size exceeded")
        with mock.patch.object(common, "run_node", return_value=trapped) as run_node:
            with self.assertRaisesRegex(common.HarnessError, "trapped at depth 7"):
                lane_c.shadow_stack("probe.wasm", "valueOf", 7)
        self.assertEqual(run_node.call_args.kwargs["stack_kb"], lane_c.SLOPE_STACK_KB)
        returned = common.Outcome(line="halt=none result=x")
        returned.shadow_stack = 4096
        with mock.patch.object(common, "run_node", return_value=returned):
            self.assertEqual(lane_c.shadow_stack("probe.wasm", "valueOf", 7), 4096)


class ChainRuns(unittest.TestCase):
    def test_a_chain_run_that_times_out_is_a_problem_not_a_fit(self):
        """A timeout is not `trapped`, and read as a family that fits the
        stack it dropped the chain without a problem."""
        problems = []
        with mock.patch.object(lane_c.ceilings, "recorded", return_value=[("valueOf", 126)]), \
                mock.patch.object(common, "run_node", return_value=TIMEOUT), \
                contextlib.redirect_stdout(io.StringIO()):
            result = lane_c.chains("probe.wasm", {}, problems)
        self.assertEqual(result, {kind: {"valueOf": None} for kind in lane_c.CHAIN_KINDS})
        self.assertEqual(problems, [f"chain {kind}/valueOf: timeout after 900s" for kind in lane_c.CHAIN_KINDS])


class TierMix(unittest.TestCase):
    def test_the_excess_is_over_the_larger_pure_tier(self):
        mix = lane_c.tier_mix({"f": [1, 2]}, {1: 100, 2: 10}, {1: 10, 2: 100})
        self.assertEqual(mix["f"]["liftoff"], 110)
        self.assertEqual(mix["f"]["turbofan"], 110)
        self.assertEqual(mix["f"]["worst_mix"], 200)
        self.assertAlmostEqual(mix["f"]["excess"], 90 / 110, places=4)

    def test_a_chain_with_no_functions_is_skipped(self):
        self.assertEqual(lane_c.tier_mix({"f": None}, {}, {}), {})

    def test_a_missing_frame_counts_as_zero(self):
        mix = lane_c.tier_mix({"f": [1, 2]}, {1: 8}, {1: 8})
        self.assertEqual(mix["f"]["excess"], 0.0)


class Model(unittest.TestCase):
    def test_one_level_is_the_sum_of_the_chain_and_names_what_native_lacks(self):
        names = {1: "a", 2: "b"}
        m = lane_c.model({"f": [1, 2], "g": None}, {"shadow": {1: 16, 2: 32}}, {"a": 8}, names)
        self.assertEqual(m, {"f": {"shadow": {"bytes_per_level": 48},
                                   "native": {"bytes_per_level": 8, "missing": ["b"]}}})

    def test_without_a_native_table_only_the_wasm_compilers_are_modelled(self):
        m = lane_c.model({"f": [1]}, {"shadow": {1: 16}}, None, {1: "a"})
        self.assertEqual(m, {"f": {"shadow": {"bytes_per_level": 16}}})


class Diff(unittest.TestCase):
    def test_the_largest_changes_come_first(self):
        old = {"frames": {"shadow": {"a": 100, "b": 50}}}
        new = {"frames": {"shadow": {"a": 90, "b": 500, "c": 8}}}
        lines = lane_c.diff(old, new, n=2)
        self.assertEqual(len(lines), 2)
        self.assertIn("+450", lines[0])
        self.assertIn("-10", lines[1])


def body(*ops, locals_=()):
    out = bytes([len(locals_)])
    for count, kind in locals_:
        out += bytes([count, kind])
    return out + b"".join(ops)


class ShadowPrologue(unittest.TestCase):
    PADDED_SP = b"\x23\x80\x80\x80\x80\x00"  # global.get 0, padded to five bytes

    def test_the_plain_prologue(self):
        self.assertEqual(wasmbin.shadow_prologue(body(self.PADDED_SP, b"\x41\xa0\x18", b"\x6b")), 3104)

    def test_the_prologue_inside_a_leading_block(self):
        self.assertEqual(wasmbin.shadow_prologue(body(b"\x02\x40", self.PADDED_SP, b"\x41\x10", b"\x6b",
                                                      locals_=((3, 0x7f),))), 16)

    def test_the_prologue_through_a_local_tee(self):
        self.assertEqual(wasmbin.shadow_prologue(body(self.PADDED_SP, b"\x22\x01", b"\x41\x20", b"\x6b")), 32)

    def test_a_function_without_a_frame_reserves_nothing(self):
        self.assertEqual(wasmbin.shadow_prologue(body(b"\x20\x00", b"\x0b")), 0)
        self.assertEqual(wasmbin.shadow_prologue(body(self.PADDED_SP, b"\x21\x01", b"\x0b")), 0)

    PADDED_SP_SET = b"\x24\x80\x80\x80\x80\x00"

    def test_a_saved_pointer_reserved_later_on_some_path_is_the_largest_reservation(self):
        prologue = body(self.PADDED_SP, b"\x21\x01", b"\x20\x00", b"\x45", b"\x04\x40",
                        b"\x20\x01", b"\x41\x10", b"\x6b", b"\x22\x02", self.PADDED_SP_SET, b"\x05",
                        b"\x20\x01", b"\x41\xc0\x00", b"\x6b", b"\x22\x02", self.PADDED_SP_SET, b"\x0b",
                        b"\x20\x01", self.PADDED_SP_SET, b"\x0b")
        self.assertEqual(wasmbin.shadow_prologue(prologue), 64)

    def test_a_saved_pointer_only_written_back_reserves_nothing(self):
        restore_only = body(self.PADDED_SP, b"\x21\x01", b"\x10\x05", b"\x20\x01", self.PADDED_SP_SET, b"\x0b")
        self.assertEqual(wasmbin.shadow_prologue(restore_only), 0)

    def test_an_unread_pointer_move_is_none_not_zero(self):
        unread = body(self.PADDED_SP, b"\x21\x01", b"\x20\x00", self.PADDED_SP_SET, b"\x0b")
        self.assertIsNone(wasmbin.shadow_prologue(unread))

    def test_leb_decoders(self):
        self.assertEqual(wasmbin.leb_u(b"\xe5\x8e\x26", 0), (624485, 3))
        self.assertEqual(wasmbin.leb_s32(b"\x7f", 0), (-1, 1))
        self.assertEqual(wasmbin.leb_s32(b"\xa0\x18", 0), (3104, 2))
        self.assertEqual(wasmbin.leb_s32(b"\xff\xff\xff\xff\x07", 0), (2 ** 31 - 1, 5))


if __name__ == "__main__":
    unittest.main()
