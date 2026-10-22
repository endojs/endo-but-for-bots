//! Daemon-side store of worker-owned TUI windows and regions
//! (designs/endor-bus-tui.md, Phase 1).
//!
//! The store is pure and synchronous: no I/O and no terminal.
//! Windows and regions are keyed by `(owner, id)`, so a worker can
//! only ever name its own state; another worker's IDs read as absent.

use std::collections::{HashMap, VecDeque};

use crate::codec::{
    self, TuiError, TuiErrorCode, TuiLayoutHint, TuiReply, TuiRequest, TuiRun,
};
use crate::types::Handle;

/// The single screen until multi-screen support lands.
pub const SCREEN_ID: i64 = 1;
/// Hard ceiling on a `buffer` region's scrollback, in lines.
pub const SCROLLBACK_CEILING: usize = 10_000;
/// Cap on the text bytes carried by one `setText` or `appendLines`,
/// and on the bytes one region retains; a `buffer` region evicts its
/// oldest lines to stay under it.
pub const MAX_TEXT_BYTES: usize = 1 << 20;
/// Cap on a window title, in bytes.
pub const MAX_TITLE_BYTES: usize = 1 << 10;
/// Bytes charged per stored run on top of its text, so empty runs and
/// lines still count against the budget.
pub const RUN_OVERHEAD_BYTES: usize = 32;
/// Cap on the bytes one owner retains across all its titles and regions.
pub const MAX_OWNER_BYTES: usize = 8 << 20;
/// Cap on the windows one owner holds.
pub const MAX_OWNER_WINDOWS: usize = 64;
/// Cap on the regions one owner holds.
pub const MAX_OWNER_REGIONS: usize = 256;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Window {
    pub title: String,
    pub role: String,
    pub layout_hint: TuiLayoutHint,
    /// Region IDs in creation order.
    pub regions: Vec<i64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RegionContent {
    Text(Vec<TuiRun>),
    Buffer {
        /// Retained lines, oldest first.
        lines: VecDeque<Vec<TuiRun>>,
        /// Line number of `lines[0]`; line numbers start at 1.
        first_line: i64,
        /// Maximum retained lines.
        capacity: usize,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Region {
    pub window_id: i64,
    pub layout_hint: Option<TuiLayoutHint>,
    pub content: RegionContent,
    /// Retained bytes, as charged by `runs_bytes`.
    pub bytes: usize,
}

/// What one owner holds, kept so every limit check is O(1).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Usage {
    bytes: usize,
    windows: usize,
    regions: usize,
}

#[derive(Debug)]
pub struct TuiStore {
    next_id: i64,
    windows: HashMap<(Handle, i64), Window>,
    regions: HashMap<(Handle, i64), Region>,
    usage: HashMap<Handle, Usage>,
}

impl Default for TuiStore {
    fn default() -> Self {
        TuiStore::new()
    }
}

fn no_such_window(id: i64) -> TuiError {
    TuiError::new(TuiErrorCode::NoSuchWindow, format!("no window {id}"))
}

fn no_such_region(id: i64) -> TuiError {
    TuiError::new(TuiErrorCode::NoSuchRegion, format!("no region {id}"))
}

fn wrong_role(msg: impl Into<String>) -> TuiError {
    TuiError::new(TuiErrorCode::WrongRole, msg)
}

fn too_large(msg: impl Into<String>) -> TuiError {
    TuiError::new(TuiErrorCode::TooLarge, msg)
}

/// Bytes charged for storing `runs`.
fn runs_bytes<'a>(runs: impl IntoIterator<Item = &'a TuiRun>) -> usize {
    runs.into_iter().map(|r| r.text.len() + RUN_OVERHEAD_BYTES).sum()
}

fn check_size(bytes: usize) -> Result<(), TuiError> {
    if bytes > MAX_TEXT_BYTES {
        return Err(too_large(format!("text exceeds {MAX_TEXT_BYTES} bytes")));
    }
    Ok(())
}

fn check_title(title: &str) -> Result<(), TuiError> {
    if title.len() > MAX_TITLE_BYTES {
        return Err(too_large(format!("title exceeds {MAX_TITLE_BYTES} bytes")));
    }
    Ok(())
}

fn check_hint(hint: Option<&TuiLayoutHint>) -> Result<(), TuiError> {
    hint.map_or(Ok(()), codec::validate_tui_layout_hint)
}

impl TuiStore {
    pub fn new() -> Self {
        TuiStore { next_id: 1, windows: HashMap::new(), regions: HashMap::new(), usage: HashMap::new() }
    }

    fn usage(&self, owner: Handle) -> Usage {
        self.usage.get(&owner).copied().unwrap_or_default()
    }

    /// Fail with `too-large` unless `owner` can retain `old` bytes
    /// replaced by `new` bytes.
    fn check_owner_bytes(&self, owner: Handle, old: usize, new: usize) -> Result<(), TuiError> {
        if new > old && self.usage(owner).bytes - old + new > MAX_OWNER_BYTES {
            return Err(too_large(format!("worker exceeds {MAX_OWNER_BYTES} retained bytes")));
        }
        Ok(())
    }

    fn adjust_usage(&mut self, owner: Handle, update: impl FnOnce(&mut Usage)) {
        let u = self.usage.entry(owner).or_default();
        update(u);
        if *u == Usage::default() {
            self.usage.remove(&owner);
        }
    }

    /// Bytes `owner` currently retains, as charged against `MAX_OWNER_BYTES`.
    pub fn owner_bytes(&self, owner: Handle) -> usize {
        self.usage(owner).bytes
    }

    fn alloc_id(&mut self) -> i64 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    pub fn window(&self, owner: Handle, id: i64) -> Option<&Window> {
        self.windows.get(&(owner, id))
    }

    pub fn region(&self, owner: Handle, id: i64) -> Option<&Region> {
        self.regions.get(&(owner, id))
    }

    /// Whether `owner` holds any window or region.
    pub fn owns_anything(&self, owner: Handle) -> bool {
        self.windows.keys().any(|(o, _)| *o == owner) || self.regions.keys().any(|(o, _)| *o == owner)
    }

    pub fn is_empty(&self) -> bool {
        self.windows.is_empty() && self.regions.is_empty()
    }

    /// Drop every window and region `owner` holds.
    pub fn sweep_owner(&mut self, owner: Handle) {
        self.windows.retain(|(o, _), _| *o != owner);
        self.regions.retain(|(o, _), _| *o != owner);
        self.usage.remove(&owner);
    }

    pub fn apply(&mut self, owner: Handle, req: TuiRequest) -> Result<TuiReply, TuiError> {
        match req {
            TuiRequest::GetScreen => Ok(TuiReply::Screen {
                screen_id: SCREEN_ID,
                cols: 80,
                rows: 24,
                color_depth: 24,
                has_mouse: false,
                has_focus: false,
                // No client renders the store until Phase 2.
                attached: false,
            }),
            TuiRequest::CreateWindow { screen_id, title, role, layout_hint } => {
                if screen_id != SCREEN_ID {
                    return Err(TuiError::bad_argument(format!("no screen {screen_id}")));
                }
                codec::validate_tui_window_role(&role)?;
                check_hint(Some(&layout_hint))?;
                check_title(&title)?;
                if self.usage(owner).windows >= MAX_OWNER_WINDOWS {
                    return Err(too_large(format!("worker exceeds {MAX_OWNER_WINDOWS} windows")));
                }
                self.check_owner_bytes(owner, 0, title.len())?;
                let id = self.alloc_id();
                let bytes = title.len();
                self.windows.insert((owner, id), Window { title, role, layout_hint, regions: Vec::new() });
                self.adjust_usage(owner, |u| {
                    u.windows += 1;
                    u.bytes += bytes;
                });
                Ok(TuiReply::Window { window_id: id })
            }
            TuiRequest::ConfigureWindow { window_id, title, layout_hint } => {
                check_hint(layout_hint.as_ref())?;
                let old = self.windows.get(&(owner, window_id)).ok_or_else(|| no_such_window(window_id))?.title.len();
                if let Some(t) = &title {
                    let new = t.len();
                    check_title(t)?;
                    self.check_owner_bytes(owner, old, new)?;
                    self.adjust_usage(owner, |u| u.bytes = u.bytes - old + new);
                }
                let w = self.windows.get_mut(&(owner, window_id)).ok_or_else(|| no_such_window(window_id))?;
                if let Some(t) = title {
                    w.title = t;
                }
                if let Some(h) = layout_hint {
                    w.layout_hint = h;
                }
                Ok(TuiReply::Empty)
            }
            TuiRequest::DestroyWindow { window_id } => {
                let w = self.windows.remove(&(owner, window_id)).ok_or_else(|| no_such_window(window_id))?;
                let mut freed = Usage { bytes: w.title.len(), windows: 1, regions: 0 };
                for r in w.regions {
                    if let Some(region) = self.regions.remove(&(owner, r)) {
                        freed.bytes += region.bytes;
                        freed.regions += 1;
                    }
                }
                self.adjust_usage(owner, |u| {
                    u.bytes -= freed.bytes;
                    u.windows -= freed.windows;
                    u.regions -= freed.regions;
                });
                Ok(TuiReply::Empty)
            }
            TuiRequest::CreateRegion { window_id, role, layout_hint, scrollback } => {
                if !self.windows.contains_key(&(owner, window_id)) {
                    return Err(no_such_window(window_id));
                }
                check_hint(layout_hint.as_ref())?;
                if self.usage(owner).regions >= MAX_OWNER_REGIONS {
                    return Err(too_large(format!("worker exceeds {MAX_OWNER_REGIONS} regions")));
                }
                let content = match role.as_str() {
                    "text" => {
                        if scrollback.is_some() {
                            return Err(TuiError::bad_argument("`scrollback` applies only to buffer regions"));
                        }
                        RegionContent::Text(Vec::new())
                    }
                    "buffer" => {
                        let capacity = match scrollback {
                            None => SCROLLBACK_CEILING,
                            Some(n) if n < 1 => {
                                return Err(TuiError::bad_argument("`scrollback` must be at least 1"));
                            }
                            Some(n) => usize::try_from(n).unwrap_or(usize::MAX).min(SCROLLBACK_CEILING),
                        };
                        RegionContent::Buffer { lines: VecDeque::new(), first_line: 1, capacity }
                    }
                    other => return Err(wrong_role(format!("region role `{other}` is not supported yet"))),
                };
                let id = self.alloc_id();
                self.regions.insert((owner, id), Region { window_id, layout_hint, content, bytes: 0 });
                if let Some(w) = self.windows.get_mut(&(owner, window_id)) {
                    w.regions.push(id);
                }
                self.adjust_usage(owner, |u| u.regions += 1);
                Ok(TuiReply::Region { region_id: id })
            }
            TuiRequest::DestroyRegion { region_id } => {
                let r = self.regions.remove(&(owner, region_id)).ok_or_else(|| no_such_region(region_id))?;
                if let Some(w) = self.windows.get_mut(&(owner, r.window_id)) {
                    w.regions.retain(|id| *id != region_id);
                }
                self.adjust_usage(owner, |u| {
                    u.bytes -= r.bytes;
                    u.regions -= 1;
                });
                Ok(TuiReply::Empty)
            }
            TuiRequest::SetText { region_id, runs } => {
                let r = self.regions.get(&(owner, region_id)).ok_or_else(|| no_such_region(region_id))?;
                if !matches!(r.content, RegionContent::Text(_)) {
                    return Err(wrong_role("tui.setText needs a text region"));
                }
                let (old, new) = (r.bytes, runs_bytes(&runs));
                check_size(new)?;
                self.check_owner_bytes(owner, old, new)?;
                self.adjust_usage(owner, |u| u.bytes = u.bytes - old + new);
                let r = self.regions.get_mut(&(owner, region_id)).ok_or_else(|| no_such_region(region_id))?;
                r.content = RegionContent::Text(runs);
                r.bytes = new;
                Ok(TuiReply::Empty)
            }
            TuiRequest::AppendLines { region_id, lines: new_lines } => {
                let r = self.regions.get(&(owner, region_id)).ok_or_else(|| no_such_region(region_id))?;
                let RegionContent::Buffer { lines, capacity, .. } = &r.content else {
                    return Err(wrong_role("tui.appendLines needs a buffer region"));
                };
                if new_lines.is_empty() {
                    return Err(TuiError::bad_argument("`lines` must not be empty"));
                }
                let added = runs_bytes(new_lines.iter().flatten());
                check_size(added)?;
                // Plan the eviction before mutating, so a refusal leaves
                // the region untouched: drop oldest lines until both the
                // line capacity and the per-region byte cap hold.
                let old = r.bytes;
                let mut count = lines.len() + new_lines.len();
                let mut bytes = old + added;
                let mut evict = 0;
                for l in lines.iter().chain(new_lines.iter()) {
                    if count <= *capacity && bytes <= MAX_TEXT_BYTES {
                        break;
                    }
                    count -= 1;
                    bytes -= runs_bytes(l);
                    evict += 1;
                }
                self.check_owner_bytes(owner, old, bytes)?;
                self.adjust_usage(owner, |u| u.bytes = u.bytes - old + bytes);
                let r = self.regions.get_mut(&(owner, region_id)).ok_or_else(|| no_such_region(region_id))?;
                r.bytes = bytes;
                let RegionContent::Buffer { lines, first_line, .. } = &mut r.content else {
                    unreachable!("role checked above");
                };
                let first = *first_line + lines.len() as i64;
                let last = first + new_lines.len() as i64 - 1;
                lines.extend(new_lines);
                for _ in 0..evict {
                    lines.pop_front();
                }
                *first_line += evict as i64;
                Ok(TuiReply::Appended { first_line: first, last_line: last })
            }
        }
    }
}

/// Decode a `tui.*` request payload, apply it on behalf of `owner`,
/// and encode the reply payload. The error is sent as an `error` reply.
pub fn dispatch(store: &mut TuiStore, owner: Handle, verb: &str, payload: &[u8]) -> Result<Vec<u8>, TuiError> {
    let req = codec::decode_tui_request(verb, payload)?;
    let reply = store.apply(owner, req)?;
    Ok(codec::encode_tui_reply(&reply))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codec::{TuiAttrs, TuiColor};

    const A: Handle = 7;
    const B: Handle = 8;

    fn run(text: &str) -> TuiRun {
        TuiRun { text: text.to_string(), attrs: TuiAttrs::default() }
    }

    fn line(text: &str) -> Vec<TuiRun> {
        vec![run(text)]
    }

    fn window(store: &mut TuiStore, owner: Handle) -> i64 {
        match store
            .apply(
                owner,
                TuiRequest::CreateWindow {
                    screen_id: SCREEN_ID,
                    title: "t".into(),
                    role: "status".into(),
                    layout_hint: TuiLayoutHint::default(),
                },
            )
            .unwrap()
        {
            TuiReply::Window { window_id } => window_id,
            r => panic!("{r:?}"),
        }
    }

    fn region(store: &mut TuiStore, owner: Handle, window_id: i64, role: &str, scrollback: Option<i64>) -> i64 {
        match store
            .apply(owner, TuiRequest::CreateRegion { window_id, role: role.into(), layout_hint: None, scrollback })
            .unwrap()
        {
            TuiReply::Region { region_id } => region_id,
            r => panic!("{r:?}"),
        }
    }

    fn append(store: &mut TuiStore, owner: Handle, region_id: i64, texts: &[&str]) -> (i64, i64) {
        let lines = texts.iter().map(|t| line(t)).collect();
        match store.apply(owner, TuiRequest::AppendLines { region_id, lines }).unwrap() {
            TuiReply::Appended { first_line, last_line } => (first_line, last_line),
            r => panic!("{r:?}"),
        }
    }

    fn code(r: Result<TuiReply, TuiError>) -> TuiErrorCode {
        r.unwrap_err().code
    }

    #[test]
    fn set_text_stores_exact_runs() {
        let mut s = TuiStore::new();
        let w = window(&mut s, A);
        let r = region(&mut s, A, w, "text", None);
        let runs = vec![
            TuiRun {
                text: "ok".into(),
                attrs: TuiAttrs { fg: Some(TuiColor::Rgb("#00ff00".into())), bold: Some(true), ..Default::default() },
            },
            run(" 3 jobs"),
        ];
        s.apply(A, TuiRequest::SetText { region_id: r, runs: runs.clone() }).unwrap();
        assert_eq!(s.region(A, r).unwrap().content, RegionContent::Text(runs));
        assert_eq!(s.window(A, w).unwrap().regions, vec![r]);
    }

    #[test]
    fn append_lines_numbers_are_monotonic() {
        let mut s = TuiStore::new();
        let w = window(&mut s, A);
        let r = region(&mut s, A, w, "buffer", None);
        assert_eq!(append(&mut s, A, r, &["a", "b"]), (1, 2));
        assert_eq!(append(&mut s, A, r, &["c"]), (3, 3));
        assert_eq!(append(&mut s, A, r, &["d", "e", "f"]), (4, 6));
    }

    #[test]
    fn scrollback_evicts_oldest_and_keeps_counting() {
        let mut s = TuiStore::new();
        let w = window(&mut s, A);
        let r = region(&mut s, A, w, "buffer", Some(3));
        assert_eq!(append(&mut s, A, r, &["1", "2", "3", "4", "5"]), (1, 5));
        match &s.region(A, r).unwrap().content {
            RegionContent::Buffer { lines, first_line, .. } => {
                assert_eq!(*first_line, 3);
                assert_eq!(lines.iter().cloned().collect::<Vec<_>>(), vec![line("3"), line("4"), line("5")]);
            }
            c => panic!("{c:?}"),
        }
        assert_eq!(append(&mut s, A, r, &["6"]), (6, 6));
    }

    #[test]
    fn scrollback_is_clamped_to_ceiling() {
        let mut s = TuiStore::new();
        let w = window(&mut s, A);
        let r = region(&mut s, A, w, "buffer", Some(SCROLLBACK_CEILING as i64 * 10));
        match &s.region(A, r).unwrap().content {
            RegionContent::Buffer { capacity, .. } => assert_eq!(*capacity, SCROLLBACK_CEILING),
            c => panic!("{c:?}"),
        }
        let unset = region(&mut s, A, w, "buffer", None);
        match &s.region(A, unset).unwrap().content {
            RegionContent::Buffer { capacity, .. } => assert_eq!(*capacity, SCROLLBACK_CEILING),
            c => panic!("{c:?}"),
        }
    }

    #[test]
    fn wrong_role_leaves_state_unchanged() {
        let mut s = TuiStore::new();
        let w = window(&mut s, A);
        let text = region(&mut s, A, w, "text", None);
        let buf = region(&mut s, A, w, "buffer", None);
        s.apply(A, TuiRequest::SetText { region_id: text, runs: vec![run("x")] }).unwrap();
        append(&mut s, A, buf, &["y"]);
        let before = (s.region(A, text).cloned(), s.region(A, buf).cloned());

        assert_eq!(
            code(s.apply(A, TuiRequest::SetText { region_id: buf, runs: vec![run("z")] })),
            TuiErrorCode::WrongRole
        );
        assert_eq!(
            code(s.apply(A, TuiRequest::AppendLines { region_id: text, lines: vec![line("z")] })),
            TuiErrorCode::WrongRole
        );
        assert_eq!((s.region(A, text).cloned(), s.region(A, buf).cloned()), before);
    }

    #[test]
    fn unsupported_region_roles_are_wrong_role() {
        let mut s = TuiStore::new();
        let w = window(&mut s, A);
        for role in ["canvas", "status", "input"] {
            let r = s.apply(
                A,
                TuiRequest::CreateRegion { window_id: w, role: role.into(), layout_hint: None, scrollback: None },
            );
            assert_eq!(code(r), TuiErrorCode::WrongRole, "{role}");
        }
        assert!(s.window(A, w).unwrap().regions.is_empty());
    }

    #[test]
    fn destroy_window_drops_its_regions() {
        let mut s = TuiStore::new();
        let w = window(&mut s, A);
        let r = region(&mut s, A, w, "text", None);
        s.apply(A, TuiRequest::DestroyWindow { window_id: w }).unwrap();
        assert!(s.is_empty());
        assert_eq!(
            code(s.apply(A, TuiRequest::SetText { region_id: r, runs: vec![] })),
            TuiErrorCode::NoSuchRegion
        );
    }

    #[test]
    fn ids_are_scoped_to_owner() {
        let mut s = TuiStore::new();
        let w = window(&mut s, A);
        let r = region(&mut s, A, w, "text", None);
        s.apply(A, TuiRequest::SetText { region_id: r, runs: vec![run("mine")] }).unwrap();
        let before = (s.window(A, w).cloned(), s.region(A, r).cloned());

        assert_eq!(
            code(s.apply(B, TuiRequest::SetText { region_id: r, runs: vec![run("theirs")] })),
            TuiErrorCode::NoSuchRegion
        );
        assert_eq!(code(s.apply(B, TuiRequest::DestroyRegion { region_id: r })), TuiErrorCode::NoSuchRegion);
        assert_eq!(code(s.apply(B, TuiRequest::DestroyWindow { window_id: w })), TuiErrorCode::NoSuchWindow);
        assert_eq!(
            code(s.apply(
                B,
                TuiRequest::CreateRegion { window_id: w, role: "text".into(), layout_hint: None, scrollback: None }
            )),
            TuiErrorCode::NoSuchWindow
        );
        assert_eq!((s.window(A, w).cloned(), s.region(A, r).cloned()), before);
    }

    #[test]
    fn sweep_owner_removes_only_that_owner() {
        let mut s = TuiStore::new();
        let wa = window(&mut s, A);
        region(&mut s, A, wa, "text", None);
        let wb = window(&mut s, B);
        let rb = region(&mut s, B, wb, "buffer", None);
        s.sweep_owner(A);
        assert!(!s.owns_anything(A));
        assert!(s.window(B, wb).is_some());
        assert!(s.region(B, rb).is_some());
    }

    #[test]
    fn oversized_text_is_too_large() {
        let mut s = TuiStore::new();
        let w = window(&mut s, A);
        let r = region(&mut s, A, w, "text", None);
        let big = vec![run(&"x".repeat(MAX_TEXT_BYTES + 1))];
        assert_eq!(code(s.apply(A, TuiRequest::SetText { region_id: r, runs: big })), TuiErrorCode::TooLarge);
    }

    #[test]
    fn oversized_title_is_too_large() {
        let mut s = TuiStore::new();
        let big = "t".repeat(MAX_TITLE_BYTES + 1);
        let r = s.apply(
            A,
            TuiRequest::CreateWindow {
                screen_id: SCREEN_ID,
                title: big.clone(),
                role: "status".into(),
                layout_hint: TuiLayoutHint::default(),
            },
        );
        assert_eq!(code(r), TuiErrorCode::TooLarge);
        let w = window(&mut s, A);
        let r = s.apply(A, TuiRequest::ConfigureWindow { window_id: w, title: Some(big), layout_hint: None });
        assert_eq!(code(r), TuiErrorCode::TooLarge);
        assert_eq!(s.window(A, w).unwrap().title, "t");
    }

    #[test]
    fn window_and_region_counts_are_capped_per_owner() {
        let mut s = TuiStore::new();
        let windows: Vec<i64> = (0..MAX_OWNER_WINDOWS).map(|_| window(&mut s, A)).collect();
        let r = s.apply(
            A,
            TuiRequest::CreateWindow {
                screen_id: SCREEN_ID,
                title: "t".into(),
                role: "status".into(),
                layout_hint: TuiLayoutHint::default(),
            },
        );
        assert_eq!(code(r), TuiErrorCode::TooLarge);
        // Another owner is unaffected.
        window(&mut s, B);
        for i in 0..MAX_OWNER_REGIONS {
            region(&mut s, A, windows[i % windows.len()], "text", None);
        }
        let r = s.apply(
            A,
            TuiRequest::CreateRegion { window_id: windows[0], role: "text".into(), layout_hint: None, scrollback: None },
        );
        assert_eq!(code(r), TuiErrorCode::TooLarge);
        // Destroying frees the slots.
        s.apply(A, TuiRequest::DestroyWindow { window_id: windows[0] }).unwrap();
        window(&mut s, A);
        region(&mut s, A, windows[1], "text", None);
    }

    #[test]
    fn buffer_bytes_are_bounded_by_eviction() {
        let mut s = TuiStore::new();
        let w = window(&mut s, A);
        let r = region(&mut s, A, w, "buffer", None);
        let chunk = "x".repeat(MAX_TEXT_BYTES / 4);
        for _ in 0..10 {
            append(&mut s, A, r, &[chunk.as_str()]);
        }
        let region = s.region(A, r).unwrap();
        assert!(region.bytes <= MAX_TEXT_BYTES);
        match &region.content {
            RegionContent::Buffer { lines, first_line, .. } => {
                assert_eq!(*first_line + lines.len() as i64 - 1, 10);
                assert_eq!(region.bytes, runs_bytes(lines.iter().flatten()));
            }
            c => panic!("{c:?}"),
        }
    }

    #[test]
    fn owner_bytes_are_capped_and_released() {
        let mut s = TuiStore::new();
        let w = window(&mut s, A);
        let chunk = vec![run(&"x".repeat(MAX_TEXT_BYTES - RUN_OVERHEAD_BYTES))];
        let per_region = runs_bytes(&chunk);
        let mut regions = Vec::new();
        loop {
            let r = region(&mut s, A, w, "text", None);
            match s.apply(A, TuiRequest::SetText { region_id: r, runs: chunk.clone() }) {
                Ok(_) => regions.push(r),
                Err(e) => {
                    assert_eq!(e.code, TuiErrorCode::TooLarge);
                    break;
                }
            }
        }
        assert!(s.owner_bytes(A) <= MAX_OWNER_BYTES);
        assert!(s.owner_bytes(A) + per_region > MAX_OWNER_BYTES);
        // Another owner still has its full budget.
        let wb = window(&mut s, B);
        let rb = region(&mut s, B, wb, "text", None);
        s.apply(B, TuiRequest::SetText { region_id: rb, runs: chunk.clone() }).unwrap();
        // Shrinking a region is always allowed and frees budget.
        s.apply(A, TuiRequest::SetText { region_id: regions[0], runs: vec![] }).unwrap();
        s.apply(A, TuiRequest::DestroyRegion { region_id: regions[1] }).unwrap();
        assert_eq!(s.owner_bytes(A), 1 + (regions.len() - 2) * per_region);
        s.apply(A, TuiRequest::DestroyWindow { window_id: w }).unwrap();
        assert_eq!(s.owner_bytes(A), 0);
        s.sweep_owner(B);
        assert_eq!(s.owner_bytes(B), 0);
        assert!(s.usage.is_empty());
    }

    #[test]
    fn apply_rechecks_decode_validation() {
        let mut s = TuiStore::new();
        let r = s.apply(
            A,
            TuiRequest::CreateWindow {
                screen_id: SCREEN_ID,
                title: "t".into(),
                role: "nope".into(),
                layout_hint: TuiLayoutHint::default(),
            },
        );
        assert_eq!(code(r), TuiErrorCode::BadArgument);
        let w = window(&mut s, A);
        let dock = TuiLayoutHint { dock: Some("middle".into()), ..Default::default() };
        let r = s.apply(A, TuiRequest::ConfigureWindow { window_id: w, title: None, layout_hint: Some(dock) });
        assert_eq!(code(r), TuiErrorCode::BadArgument);
        let negative = TuiLayoutHint { min_rows: Some(-1), ..Default::default() };
        let r = s.apply(
            A,
            TuiRequest::CreateRegion { window_id: w, role: "text".into(), layout_hint: Some(negative), scrollback: None },
        );
        assert_eq!(code(r), TuiErrorCode::BadArgument);
        assert!(s.window(A, w).unwrap().regions.is_empty());
    }

    #[test]
    fn dispatch_full_sequence() {
        let mut s = TuiStore::new();
        let mut call = |req: TuiRequest| -> TuiReply {
            let verb = codec::tui_request_verb(&req);
            let out = dispatch(&mut s, A, verb, &codec::encode_tui_request(&req)).unwrap();
            codec::decode_tui_reply(verb, &out).unwrap()
        };
        let screen = call(TuiRequest::GetScreen);
        assert!(matches!(screen, TuiReply::Screen { screen_id: SCREEN_ID, attached: false, .. }));
        let TuiReply::Window { window_id } = call(TuiRequest::CreateWindow {
            screen_id: SCREEN_ID,
            title: "build".into(),
            role: "status".into(),
            layout_hint: TuiLayoutHint { dock: Some("bottom".into()), min_rows: Some(1), ..Default::default() },
        }) else {
            panic!()
        };
        let TuiReply::Region { region_id: text } = call(TuiRequest::CreateRegion {
            window_id,
            role: "text".into(),
            layout_hint: None,
            scrollback: None,
        }) else {
            panic!()
        };
        let TuiReply::Region { region_id: buf } = call(TuiRequest::CreateRegion {
            window_id,
            role: "buffer".into(),
            layout_hint: None,
            scrollback: Some(100),
        }) else {
            panic!()
        };
        assert_eq!(call(TuiRequest::SetText { region_id: text, runs: vec![run("ok")] }), TuiReply::Empty);
        assert_eq!(
            call(TuiRequest::AppendLines { region_id: buf, lines: vec![line("a"), line("b")] }),
            TuiReply::Appended { first_line: 1, last_line: 2 }
        );
        assert_eq!(
            call(TuiRequest::ConfigureWindow { window_id, title: Some("built".into()), layout_hint: None }),
            TuiReply::Empty
        );
        assert_eq!(call(TuiRequest::DestroyRegion { region_id: buf }), TuiReply::Empty);
        assert_eq!(call(TuiRequest::DestroyWindow { window_id }), TuiReply::Empty);
        assert!(s.is_empty());
    }

    #[test]
    fn dispatch_unknown_verb_is_bad_argument() {
        let mut s = TuiStore::new();
        let err = dispatch(&mut s, A, "tui.frobnicate", &codec::encode_tui_reply(&TuiReply::Empty)).unwrap_err();
        assert_eq!(err.code, TuiErrorCode::BadArgument);
        let err = dispatch(&mut s, A, "tui.drawCells", &[]).unwrap_err();
        assert_eq!(err.code, TuiErrorCode::BadArgument);
    }

    #[test]
    fn dispatch_error_payload_round_trips() {
        let mut s = TuiStore::new();
        let req = TuiRequest::DestroyWindow { window_id: 99 };
        let err = dispatch(&mut s, A, "tui.destroyWindow", &codec::encode_tui_request(&req)).unwrap_err();
        assert_eq!(codec::decode_tui_error(&codec::encode_tui_error(&err)).unwrap(), err);
        assert_eq!(err.code, TuiErrorCode::NoSuchWindow);
    }
}
