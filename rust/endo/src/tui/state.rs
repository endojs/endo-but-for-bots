//! Pure TUI state: the mode state machine, the transcript, inventory,
//! pending-commands region, and command bar (designs/endor-tui.md
//! § Chat TUI). Nothing here touches the terminal or the socket, so the
//! whole key-handling surface is unit-testable.

use super::bus::{BusEvent, BusRequest};

/// The closed set of modes from § Keybinding scheme. `modal` arrives
/// with value inspection in Phase 3.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Normal,
    Insert,
    Focus,
}

/// Terminal-independent key events, translated from crossterm in
/// `tui::mod`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Key {
    Char(char),
    Ctrl(char),
    CtrlUp,
    Enter,
    Esc,
    Backspace,
    Up,
    Down,
}

/// Side effects the event loop performs on behalf of the state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Effect {
    Bus(BusRequest),
    Redraw,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Message {
    pub number: u64,
    pub date: String,
    pub from: String,
    pub to: Option<String>,
    pub body: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Settlement {
    Pending,
    Fulfilled(String),
    Rejected(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingCommand {
    pub id: u64,
    pub command: String,
    pub settlement: Settlement,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Connection {
    Connecting,
    Live,
    Lost { attempt: u32, retry_ms: u64 },
}

/// How many settled commands the pending region keeps visible.
const SETTLED_RETAINED: usize = 3;

#[derive(Debug)]
pub struct App {
    pub mode: Mode,
    pub input: String,
    pub messages: Vec<Message>,
    pub inventory: Vec<String>,
    pub pending: Vec<PendingCommand>,
    /// Index into `messages` while in focus mode.
    pub focus: Option<usize>,
    pub connection: Connection,
    pub profile: String,
    pub last_recipient: Option<String>,
    /// One-line feedback (parse errors, ex-command results).
    pub status: Option<String>,
    pub quit: bool,
    next_command_id: u64,
}

impl App {
    pub fn new(profile: impl Into<String>) -> Self {
        App {
            mode: Mode::Normal,
            input: String::new(),
            messages: Vec::new(),
            inventory: Vec::new(),
            pending: Vec::new(),
            focus: None,
            connection: Connection::Connecting,
            profile: profile.into(),
            last_recipient: None,
            status: None,
            quit: false,
            next_command_id: 1,
        }
    }

    /// The modeline for the current state (§ Modeline).
    pub fn modeline(&self) -> String {
        match self.mode {
            Mode::Normal => "─ i insert · f focus · : command · q quit ─".to_string(),
            Mode::Focus => {
                "─ ↑↓ nav · d dismiss · a adopt · r reply · g/G first/last · Esc exit ─".to_string()
            }
            Mode::Insert if self.input.starts_with('/') => {
                "─ /dismiss N · /adopt N name · Enter run · Esc cancel ─".to_string()
            }
            Mode::Insert if self.input.starts_with(':') => {
                "─ :quit · :reconnect · Enter run · Esc cancel ─".to_string()
            }
            Mode::Insert => match &self.last_recipient {
                Some(r) if self.input.is_empty() => {
                    format!("─ @ message · / commands · Space @{r} · Esc normal ─")
                }
                _ => "─ @ message · / commands · Enter send · Esc normal ─".to_string(),
            },
        }
    }

    pub fn handle_key(&mut self, key: Key) -> Vec<Effect> {
        // Global chords: Ctrl+C always quits, Ctrl+L always redraws.
        match key {
            Key::Ctrl('c') => {
                self.quit = true;
                return vec![];
            }
            Key::Ctrl('l') => return vec![Effect::Redraw],
            _ => {}
        }
        match self.mode {
            Mode::Normal => self.normal_key(key),
            Mode::Insert => self.insert_key(key),
            Mode::Focus => self.focus_key(key),
        }
    }

    fn normal_key(&mut self, key: Key) -> Vec<Effect> {
        match key {
            Key::Char('q') => self.quit = true,
            Key::Char('i') | Key::Enter => self.mode = Mode::Insert,
            Key::Char('f') => self.enter_focus(),
            Key::Char(':') => {
                self.mode = Mode::Insert;
                self.input = ":".to_string();
            }
            Key::Char(c @ ('/' | '@')) => {
                self.mode = Mode::Insert;
                self.input.push(c);
            }
            _ => {}
        }
        vec![]
    }

    fn insert_key(&mut self, key: Key) -> Vec<Effect> {
        match key {
            Key::Esc => {
                self.mode = Mode::Normal;
                self.input.clear();
            }
            Key::CtrlUp if self.input.is_empty() => self.enter_focus(),
            Key::Backspace => {
                self.input.pop();
            }
            Key::Char(' ') if self.input.is_empty() => {
                if let Some(r) = &self.last_recipient {
                    self.input = format!("@{r} ");
                } else {
                    self.input.push(' ');
                }
            }
            Key::Char(c) => self.input.push(c),
            Key::Enter => return self.submit_input(),
            _ => {}
        }
        vec![]
    }

    fn focus_key(&mut self, key: Key) -> Vec<Effect> {
        let len = self.messages.len();
        match (key, self.focus) {
            (Key::Esc, _) => self.leave_focus(),
            (Key::Up, Some(i)) => self.focus = Some(i.saturating_sub(1)),
            (Key::Down, Some(i)) if i + 1 >= len => self.leave_focus(),
            (Key::Down, Some(i)) => self.focus = Some(i + 1),
            (Key::Char('g'), Some(_)) => self.focus = Some(0),
            (Key::Char('G'), Some(_)) => self.focus = Some(len - 1),
            (Key::Char(c @ ('d' | 'a' | 'r')), Some(i)) => {
                let n = self.messages[i].number;
                self.input = match c {
                    'd' => format!("/dismiss {n}"),
                    'a' => format!("/adopt {n} "),
                    _ => format!("@{} ", self.messages[i].from),
                };
                self.focus = None;
                self.mode = Mode::Insert;
            }
            _ => {}
        }
        vec![]
    }

    fn enter_focus(&mut self) {
        if self.messages.is_empty() {
            self.status = Some("no messages to focus".to_string());
            return;
        }
        self.focus = Some(self.messages.len() - 1);
        self.mode = Mode::Focus;
    }

    fn leave_focus(&mut self) {
        self.focus = None;
        self.mode = Mode::Insert;
    }

    fn submit_input(&mut self) -> Vec<Effect> {
        let line = std::mem::take(&mut self.input);
        let trimmed = line.trim();
        self.status = None;
        if trimmed.is_empty() {
            return vec![];
        }
        if let Some(ex) = trimmed.strip_prefix(':') {
            self.mode = Mode::Normal;
            return match ex.trim() {
                "q" | "quit" => {
                    self.quit = true;
                    vec![]
                }
                "reconnect" => vec![Effect::Bus(BusRequest::Reconnect)],
                other => {
                    self.status = Some(format!("unknown command :{other}"));
                    vec![]
                }
            };
        }
        if let Some(command) = trimmed.strip_prefix('/') {
            let id = self.next_command_id;
            self.next_command_id += 1;
            self.pending.push(PendingCommand {
                id,
                command: command.to_string(),
                settlement: Settlement::Pending,
            });
            return vec![Effect::Bus(BusRequest::Submit {
                id,
                command: command.to_string(),
            })];
        }
        match parse_send(trimmed) {
            Some((to, body)) => {
                self.last_recipient = Some(to.clone());
                vec![Effect::Bus(BusRequest::Send { to, body })]
            }
            None => {
                self.status = Some("address a message with @name".to_string());
                self.input = line;
                vec![]
            }
        }
    }

    /// Folds a daemon event into the view state.
    pub fn apply(&mut self, event: BusEvent) {
        match event {
            BusEvent::Connected => self.connection = Connection::Live,
            BusEvent::Disconnected { attempt, retry_ms } => {
                // Keep the last-known state visible (§ Process model).
                self.connection = Connection::Lost { attempt, retry_ms };
            }
            BusEvent::MessageAdded(m) => {
                if !self.messages.iter().any(|x| x.number == m.number) {
                    self.messages.push(m);
                    self.messages.sort_by_key(|x| x.number);
                }
            }
            BusEvent::MessageRemoved { number } => {
                if let Some(pos) = self.messages.iter().position(|x| x.number == number) {
                    self.messages.remove(pos);
                    if let Some(f) = self.focus {
                        if self.messages.is_empty() {
                            self.leave_focus();
                        } else {
                            self.focus = Some(f.min(self.messages.len() - 1));
                        }
                    }
                }
            }
            BusEvent::InventoryAdded { name } => {
                if let Err(pos) = self.inventory.binary_search(&name) {
                    self.inventory.insert(pos, name);
                }
            }
            BusEvent::InventoryRemoved { name } => {
                self.inventory.retain(|n| *n != name);
            }
            BusEvent::CommandSettled { id, ok, text } => {
                if let Some(p) = self.pending.iter_mut().find(|p| p.id == id) {
                    p.settlement = if ok {
                        Settlement::Fulfilled(text)
                    } else {
                        Settlement::Rejected(text)
                    };
                }
                self.trim_settled();
            }
        }
    }

    fn trim_settled(&mut self) {
        let settled = self
            .pending
            .iter()
            .filter(|p| p.settlement != Settlement::Pending)
            .count();
        let mut excess = settled.saturating_sub(SETTLED_RETAINED);
        self.pending.retain(|p| {
            if excess > 0 && p.settlement != Settlement::Pending {
                excess -= 1;
                false
            } else {
                true
            }
        });
    }
}

/// Splits `@name body` into recipient and body.
pub fn parse_send(line: &str) -> Option<(String, String)> {
    let rest = line.strip_prefix('@')?;
    let (to, body) = rest.split_once(char::is_whitespace)?;
    let body = body.trim();
    if to.is_empty() || body.is_empty() {
        return None;
    }
    Some((to.to_string(), body.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(number: u64, from: &str) -> Message {
        Message {
            number,
            date: String::new(),
            from: from.to_string(),
            to: None,
            body: format!("body {number}"),
        }
    }

    fn type_str(app: &mut App, s: &str) -> Vec<Effect> {
        let mut out = vec![];
        for c in s.chars() {
            out.extend(app.handle_key(Key::Char(c)));
        }
        out
    }

    #[test]
    fn starts_normal_and_q_quits() {
        let mut app = App::new("@self");
        assert_eq!(app.mode, Mode::Normal);
        app.handle_key(Key::Char('q'));
        assert!(app.quit);
    }

    #[test]
    fn ctrl_c_quits_from_insert() {
        let mut app = App::new("@self");
        app.handle_key(Key::Char('i'));
        app.handle_key(Key::Ctrl('c'));
        assert!(app.quit);
    }

    #[test]
    fn send_addresses_recipient_and_remembers_it() {
        let mut app = App::new("@self");
        app.handle_key(Key::Char('i'));
        type_str(&mut app, "@alice hello there");
        let fx = app.handle_key(Key::Enter);
        assert_eq!(
            fx,
            vec![Effect::Bus(BusRequest::Send {
                to: "alice".into(),
                body: "hello there".into()
            })]
        );
        assert_eq!(app.last_recipient.as_deref(), Some("alice"));
        assert!(app.input.is_empty());
        // Space on an empty bar pre-fills the last recipient.
        app.handle_key(Key::Char(' '));
        assert_eq!(app.input, "@alice ");
    }

    #[test]
    fn unaddressed_send_is_kept_with_status() {
        let mut app = App::new("@self");
        app.handle_key(Key::Char('i'));
        type_str(&mut app, "hello");
        assert!(app.handle_key(Key::Enter).is_empty());
        assert_eq!(app.input, "hello");
        assert!(app.status.is_some());
    }

    #[test]
    fn slash_command_submits_and_settles() {
        let mut app = App::new("@self");
        type_str(&mut app, "/dismiss 42");
        assert_eq!(app.mode, Mode::Insert);
        let fx = app.handle_key(Key::Enter);
        assert_eq!(
            fx,
            vec![Effect::Bus(BusRequest::Submit {
                id: 1,
                command: "dismiss 42".into()
            })]
        );
        assert_eq!(app.pending[0].settlement, Settlement::Pending);
        app.apply(BusEvent::CommandSettled {
            id: 1,
            ok: true,
            text: "dismissed".into(),
        });
        assert_eq!(
            app.pending[0].settlement,
            Settlement::Fulfilled("dismissed".into())
        );
    }

    #[test]
    fn settled_commands_are_trimmed() {
        let mut app = App::new("@self");
        for n in 0..5 {
            type_str(&mut app, &format!("/dismiss {n}"));
            app.handle_key(Key::Enter);
        }
        for id in 1..=5 {
            app.apply(BusEvent::CommandSettled {
                id,
                ok: true,
                text: String::new(),
            });
        }
        assert_eq!(app.pending.len(), SETTLED_RETAINED);
        assert_eq!(app.pending[0].id, 3);
    }

    #[test]
    fn focus_mode_navigates_and_prefills() {
        let mut app = App::new("@self");
        for n in [42, 43, 44] {
            app.apply(BusEvent::MessageAdded(msg(n, "alice")));
        }
        app.handle_key(Key::Char('f'));
        assert_eq!(app.mode, Mode::Focus);
        assert_eq!(app.focus, Some(2));
        app.handle_key(Key::Up);
        app.handle_key(Key::Up);
        app.handle_key(Key::Up);
        assert_eq!(app.focus, Some(0));
        app.handle_key(Key::Char('G'));
        app.handle_key(Key::Up);
        app.handle_key(Key::Char('d'));
        assert_eq!(app.mode, Mode::Insert);
        assert_eq!(app.input, "/dismiss 43");
    }

    #[test]
    fn ctrl_up_on_empty_input_enters_focus_and_down_past_last_exits() {
        let mut app = App::new("@self");
        app.apply(BusEvent::MessageAdded(msg(1, "bob")));
        app.handle_key(Key::Char('i'));
        app.handle_key(Key::CtrlUp);
        assert_eq!(app.mode, Mode::Focus);
        app.handle_key(Key::Down);
        assert_eq!(app.mode, Mode::Insert);
        assert_eq!(app.focus, None);
    }

    #[test]
    fn removed_message_clamps_focus() {
        let mut app = App::new("@self");
        app.apply(BusEvent::MessageAdded(msg(1, "bob")));
        app.apply(BusEvent::MessageAdded(msg(2, "bob")));
        app.handle_key(Key::Char('f'));
        app.apply(BusEvent::MessageRemoved { number: 2 });
        assert_eq!(app.focus, Some(0));
        app.apply(BusEvent::MessageRemoved { number: 1 });
        assert_eq!(app.mode, Mode::Insert);
    }

    #[test]
    fn messages_dedupe_and_sort() {
        let mut app = App::new("@self");
        app.apply(BusEvent::MessageAdded(msg(2, "a")));
        app.apply(BusEvent::MessageAdded(msg(1, "a")));
        app.apply(BusEvent::MessageAdded(msg(2, "a")));
        let ns: Vec<_> = app.messages.iter().map(|m| m.number).collect();
        assert_eq!(ns, vec![1, 2]);
    }

    #[test]
    fn inventory_is_sorted_set() {
        let mut app = App::new("@self");
        for n in ["bob", "alice", "bob"] {
            app.apply(BusEvent::InventoryAdded { name: n.into() });
        }
        assert_eq!(app.inventory, vec!["alice", "bob"]);
        app.apply(BusEvent::InventoryRemoved {
            name: "alice".into(),
        });
        assert_eq!(app.inventory, vec!["bob"]);
    }

    #[test]
    fn ex_commands() {
        let mut app = App::new("@self");
        app.handle_key(Key::Char(':'));
        type_str(&mut app, "reconnect");
        assert_eq!(
            app.handle_key(Key::Enter),
            vec![Effect::Bus(BusRequest::Reconnect)]
        );
        assert_eq!(app.mode, Mode::Normal);
        app.handle_key(Key::Char(':'));
        type_str(&mut app, "quit");
        app.handle_key(Key::Enter);
        assert!(app.quit);
    }

    #[test]
    fn disconnect_keeps_state() {
        let mut app = App::new("@self");
        app.apply(BusEvent::Connected);
        app.apply(BusEvent::MessageAdded(msg(1, "a")));
        app.apply(BusEvent::Disconnected {
            attempt: 2,
            retry_ms: 1000,
        });
        assert_eq!(app.messages.len(), 1);
        assert!(matches!(
            app.connection,
            Connection::Lost { attempt: 2, .. }
        ));
    }

    #[test]
    fn modeline_tracks_state() {
        let mut app = App::new("@self");
        assert!(app.modeline().contains("q quit"));
        app.handle_key(Key::Char('/'));
        assert!(app.modeline().contains("/dismiss"));
        app.handle_key(Key::Esc);
        app.last_recipient = Some("alice".into());
        app.handle_key(Key::Char('i'));
        assert!(app.modeline().contains("Space @alice"));
    }

    #[test]
    fn parse_send_cases() {
        assert_eq!(
            parse_send("@a  hi "),
            Some(("a".to_string(), "hi".to_string()))
        );
        assert_eq!(parse_send("@a"), None);
        assert_eq!(parse_send("@ hi"), None);
        assert_eq!(parse_send("hi"), None);
    }
}
