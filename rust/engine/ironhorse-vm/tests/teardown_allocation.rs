//! The compiler's AST ([`Item`], [`Node`]) and `JSON.parse`'s reviver source
//! tree ([`JsonSourceTree`]) are freed by iterative `Drop` impls that neither
//! recurse (STACK-DEPTH-REFACTOR.md B6 and D1c) nor allocate: an allocation
//! failure inside a destructor can only abort, so a teardown that grew a heap
//! worklist could turn a refusal into an abort.
//!
//! Each tree drops on a 128 KiB thread, which a recursion over it would
//! overflow, while this binary's global allocator counts the allocations that
//! thread makes; the teardown must make none. The count is armed only around
//! the drop and only on the dropping thread, so building the tree, the
//! harness, and tests running beside it do not count. A control checks that
//! a teardown that grows a worklist is caught on the branching shapes.
//!
//! The counting allocator is this binary's only `unsafe`: [`GlobalAlloc`]
//! cannot be implemented without it. It forwards every call to [`System`]
//! unchanged. The engine's library roots stay `forbid(unsafe_code)`; like the
//! stack painter `stack_height.rs` includes, this is test-binary code.

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::sync::mpsc;
use std::time::Duration;

use ironhorse_compile::{Item, Node, Token, Value};
use ironhorse_vm::diagnostics::JsonSourceTree;

/// Forwards to [`System`], counting the calling thread's allocations while
/// that thread is in [`allocations_in`].
struct CountingAllocator;

thread_local! {
    /// `Some(count)` while this thread's allocations are being counted. A
    /// const-initialized `Cell` needs no lazy initialization and no
    /// destructor, so reading it never allocates.
    static COUNTED: Cell<Option<usize>> = const { Cell::new(None) };
}

fn note_allocation() {
    // `try_with`: a thread being torn down may allocate after its locals.
    let _ = COUNTED.try_with(|counted| {
        if let Some(count) = counted.get() {
            counted.set(Some(count + 1));
        }
    });
}

// SAFETY: every method forwards its arguments to `System` unchanged, so each
// upholds the `GlobalAlloc` contract exactly as `System` does. Counting only
// touches a thread-local `Cell`, which never allocates or unwinds.
unsafe impl GlobalAlloc for CountingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        note_allocation();
        System.alloc(layout)
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        note_allocation();
        System.alloc_zeroed(layout)
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        note_allocation();
        System.realloc(ptr, layout, new_size)
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        System.dealloc(ptr, layout)
    }
}

#[global_allocator]
static ALLOCATOR: CountingAllocator = CountingAllocator;

/// How many allocations (and reallocations) `f` makes on this thread.
fn allocations_in(f: impl FnOnce()) -> usize {
    COUNTED.set(Some(0));
    f();
    COUNTED.replace(None).expect("the count was armed")
}

/// Run `teardown` over `tree` on a thread whose stack would not hold a
/// recursion over it, and return the allocations it made. Fails rather than
/// hangs if the teardown does not finish.
fn free_on_small_stack<T: Send + 'static>(tree: T, teardown: fn(T)) -> usize {
    let (done, finished) = mpsc::channel();
    std::thread::Builder::new()
        .stack_size(128 * 1024)
        .spawn(move || {
            let allocations = allocations_in(|| teardown(tree));
            let _ = done.send(allocations);
        })
        .expect("spawn");
    finished
        .recv_timeout(Duration::from_secs(60))
        .expect("the tree is freed without recursing, in bounded time")
}

/// Drop each shape on a small stack; name every one whose drop allocated.
fn assert_drop_without_allocating<T: Send + 'static>(shapes: Vec<(&'static str, T)>) {
    let allocating: Vec<String> = shapes
        .into_iter()
        .filter_map(|(shape, tree)| match free_on_small_stack(tree, drop) {
            0 => None,
            allocations => Some(format!("{shape}: {allocations}")),
        })
        .collect();
    assert!(
        allocating.is_empty(),
        "dropping these trees allocated: {allocating:?}"
    );
}

fn node(children: Vec<Item>) -> Item {
    Item::Node(Box::new(Node::new(Token::Add, 1, 0, children, Value::None)))
}

/// AST shapes: chains far past `TREE_DEPTH_LIMIT`, as a refused flat chain's
/// partial tree can be (`Node::new` measures depth in constant time); a wide
/// node; a comb, every level of which holds siblings on both sides of the
/// next, so each parked worklist resumes with children still pending; and a
/// full ternary tree.
fn ast_shapes() -> Vec<(&'static str, Item)> {
    let mut node_chain = Item::Null;
    let mut mixed_chain = Item::Null;
    for level in 0..200_000u32 {
        node_chain = node(vec![node_chain]);
        mixed_chain = if level % 2 == 0 {
            node(vec![mixed_chain, Item::Null])
        } else {
            Item::List(vec![mixed_chain])
        };
    }
    let wide = node(
        (0..10_000)
            .map(|i| match i % 4 {
                0 => Item::Null,
                1 => Item::Symbol(vec![u16::from(b'a')]),
                2 => Item::List(Vec::with_capacity(8)),
                _ => node(Vec::new()),
            })
            .collect(),
    );
    let mut comb = Item::Null;
    for level in 0..50_000u32 {
        comb = if level % 2 == 0 {
            node(vec![Item::Null, comb, node(vec![Item::Null])])
        } else {
            Item::List(vec![Item::Symbol(Vec::new()), comb, Item::List(vec![])])
        };
    }
    fn full(depth: u32) -> Item {
        if depth == 0 {
            return Item::Null;
        }
        let children = vec![full(depth - 1), full(depth - 1), full(depth - 1)];
        if depth % 2 == 0 {
            node(children)
        } else {
            Item::List(children)
        }
    }
    vec![
        ("node chain", node_chain),
        ("mixed chain", Item::List(vec![mixed_chain])),
        ("wide node", wide),
        ("comb", node(vec![comb])),
        ("full tree", node(vec![full(9)])),
    ]
}

/// The same shapes over the reviver's source tree.
fn json_source_shapes() -> Vec<(&'static str, JsonSourceTree)> {
    let mut array_chain = JsonSourceTree::leaf();
    let mut mixed_chain = JsonSourceTree::leaf();
    for level in 0..200_000u32 {
        array_chain = JsonSourceTree::array(vec![array_chain]);
        mixed_chain = if level % 2 == 0 {
            JsonSourceTree::object(vec![mixed_chain])
        } else {
            JsonSourceTree::array(vec![mixed_chain])
        };
    }
    let wide = JsonSourceTree::array(
        (0..10_000)
            .map(|i| match i % 3 {
                0 => JsonSourceTree::leaf(),
                1 => JsonSourceTree::array(Vec::new()),
                _ => JsonSourceTree::object(Vec::new()),
            })
            .collect(),
    );
    let mut comb = JsonSourceTree::leaf();
    for level in 0..50_000u32 {
        comb = if level % 2 == 0 {
            JsonSourceTree::array(vec![
                JsonSourceTree::leaf(),
                comb,
                JsonSourceTree::leaf(),
                JsonSourceTree::empty(),
            ])
        } else {
            JsonSourceTree::object(vec![
                JsonSourceTree::leaf(),
                comb,
                JsonSourceTree::array(vec![JsonSourceTree::leaf(), JsonSourceTree::leaf()]),
            ])
        };
    }
    fn full(depth: u32) -> JsonSourceTree {
        if depth == 0 {
            return JsonSourceTree::leaf();
        }
        let children = vec![full(depth - 1), full(depth - 1), full(depth - 1)];
        if depth % 2 == 0 {
            JsonSourceTree::array(children)
        } else {
            JsonSourceTree::object(children)
        }
    }
    vec![
        ("array chain", array_chain),
        ("mixed chain", mixed_chain),
        ("wide array", wide),
        ("comb", comb),
        ("full tree", full(9)),
    ]
}

#[test]
fn ast_trees_drop_without_recursing_or_allocating() {
    assert_drop_without_allocating(ast_shapes());
}

#[test]
fn json_source_trees_drop_without_recursing_or_allocating() {
    assert_drop_without_allocating(json_source_shapes());
}

/// A teardown that keeps a heap worklist, appending each node's children to
/// it, as the one before the in-place teardowns did.
fn worklist_teardown(tree: Item) {
    let mut work = vec![tree];
    while let Some(item) = work.pop() {
        match item {
            Item::Node(mut node) => work.append(&mut node.children),
            Item::List(mut list) => work.append(&mut list),
            Item::Symbol(_) | Item::Null => {}
        }
    }
}

#[test]
fn a_teardown_that_grows_a_worklist_is_caught() {
    for (shape, tree) in ast_shapes() {
        if matches!(shape, "comb" | "full tree") {
            let allocations = free_on_small_stack(tree, worklist_teardown);
            assert!(
                allocations > 1,
                "the {shape} must grow a worklist past its first buffer: {allocations}"
            );
        }
    }
}
