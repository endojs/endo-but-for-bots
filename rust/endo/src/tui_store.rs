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
/// Cap on the text bytes carried by one `setText` or `appendLines`.
pub const MAX_TEXT_BYTES: usize = 1 << 20;

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
}

#[derive(Debug)]
pub struct TuiStore {
    next_id: i64,
    windows: HashMap<(Handle, i64), Window>,
    regions: HashMap<(Handle, i64), Region>,
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

fn check_size<'a>(runs: impl Iterator<Item = &'a TuiRun>) -> Result<(), TuiError> {
    let mut total = 0usize;
    for r in runs {
        total += r.text.len();
        if total > MAX_TEXT_BYTES {
            return Err(TuiError::new(
                TuiErrorCode::TooLarge,
                format!("text exceeds {MAX_TEXT_BYTES} bytes"),
            ));
        }
    }
    Ok(())
}

impl TuiStore {
    pub fn new() -> Self {
        TuiStore { next_id: 1, windows: HashMap::new(), regions: HashMap::new() }
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
                let id = self.alloc_id();
                self.windows.insert((owner, id), Window { title, role, layout_hint, regions: Vec::new() });
                Ok(TuiReply::Window { window_id: id })
            }
            TuiRequest::ConfigureWindow { window_id, title, layout_hint } => {
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
                for r in w.regions {
                    self.regions.remove(&(owner, r));
                }
                Ok(TuiReply::Empty)
            }
            TuiRequest::CreateRegion { window_id, role, layout_hint, scrollback } => {
                if !self.windows.contains_key(&(owner, window_id)) {
                    return Err(no_such_window(window_id));
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
                self.regions.insert((owner, id), Region { window_id, layout_hint, content });
                if let Some(w) = self.windows.get_mut(&(owner, window_id)) {
                    w.regions.push(id);
                }
                Ok(TuiReply::Region { region_id: id })
            }
            TuiRequest::DestroyRegion { region_id } => {
                let r = self.regions.remove(&(owner, region_id)).ok_or_else(|| no_such_region(region_id))?;
                if let Some(w) = self.windows.get_mut(&(owner, r.window_id)) {
                    w.regions.retain(|id| *id != region_id);
                }
                Ok(TuiReply::Empty)
            }
            TuiRequest::SetText { region_id, runs } => {
                let r = self.regions.get_mut(&(owner, region_id)).ok_or_else(|| no_such_region(region_id))?;
                match &mut r.content {
                    RegionContent::Text(content) => {
                        check_size(runs.iter())?;
                        *content = runs;
                        Ok(TuiReply::Empty)
                    }
                    _ => Err(wrong_role("tui.setText needs a text region")),
                }
            }
            TuiRequest::AppendLines { region_id, lines: new_lines } => {
                let r = self.regions.get_mut(&(owner, region_id)).ok_or_else(|| no_such_region(region_id))?;
                match &mut r.content {
                    RegionContent::Buffer { lines, first_line, capacity } => {
                        if new_lines.is_empty() {
                            return Err(TuiError::bad_argument("`lines` must not be empty"));
                        }
                        check_size(new_lines.iter().flatten())?;
                        let first = *first_line + lines.len() as i64;
                        let last = first + new_lines.len() as i64 - 1;
                        lines.extend(new_lines);
                        while lines.len() > *capacity {
                            lines.pop_front();
                            *first_line += 1;
                        }
                        Ok(TuiReply::Appended { first_line: first, last_line: last })
                    }
                    _ => Err(wrong_role("tui.appendLines needs a buffer region")),
                }
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
