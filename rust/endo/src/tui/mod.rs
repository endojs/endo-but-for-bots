//! `endor tui` — the terminal user interface (designs/endor-tui.md).
//!
//! Phase 1: a single-space chat view (inbox transcript, inventory,
//! pending commands, command bar with modeline) over an async bus
//! client that reconnects with backoff. The event loop owns the
//! terminal; `state` owns every decision and `ui` only renders.

pub mod bus;
pub mod state;
pub mod ui;

use std::io;
use std::path::PathBuf;

use crossterm::event::{self, Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use crossterm::execute;
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use ratatui::backend::CrosstermBackend;
use ratatui::Terminal;
use tokio::sync::mpsc;

use state::{App, Effect, Key};

/// Translates a crossterm key into the state machine's key, if bound.
pub fn translate_key(k: KeyEvent) -> Option<Key> {
    if k.kind != KeyEventKind::Press {
        return None;
    }
    let ctrl = k.modifiers.contains(KeyModifiers::CONTROL);
    Some(match k.code {
        KeyCode::Char(c) if ctrl => Key::Ctrl(c.to_ascii_lowercase()),
        KeyCode::Char(c) => Key::Char(c),
        KeyCode::Up if ctrl => Key::CtrlUp,
        KeyCode::Up => Key::Up,
        KeyCode::Down => Key::Down,
        KeyCode::Enter => Key::Enter,
        KeyCode::Esc => Key::Esc,
        KeyCode::Backspace => Key::Backspace,
        _ => return None,
    })
}

/// Restores the terminal on every exit path, including panics.
struct TerminalGuard;

impl TerminalGuard {
    fn enter() -> io::Result<Self> {
        enable_raw_mode()?;
        execute!(io::stdout(), EnterAlternateScreen)?;
        Ok(TerminalGuard)
    }
}

fn restore_terminal() {
    let _ = disable_raw_mode();
    let _ = execute!(io::stdout(), LeaveAlternateScreen, crossterm::cursor::Show);
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        restore_terminal();
    }
}

enum Input {
    Key(Key),
    Resize,
}

/// Runs the TUI against the daemon socket at `sock_path` until the user
/// quits.
pub fn run(sock_path: PathBuf, profile: String) -> io::Result<()> {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    rt.block_on(run_async(sock_path, profile))
}

async fn run_async(sock_path: PathBuf, profile: String) -> io::Result<()> {
    let prev_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        restore_terminal();
        prev_hook(info);
    }));

    let _guard = TerminalGuard::enter()?;
    let mut terminal = Terminal::new(CrosstermBackend::new(io::stdout()))?;
    terminal.clear()?;

    let (ev_tx, mut ev_rx) = mpsc::unbounded_channel();
    let (req_tx, req_rx) = mpsc::unbounded_channel();
    let bus_task = tokio::spawn(bus::run(sock_path, ev_tx, req_rx));

    // crossterm's blocking reader lives on its own thread; SIGWINCH
    // arrives through it as `Event::Resize`.
    let (in_tx, mut in_rx) = mpsc::unbounded_channel();
    std::thread::spawn(move || loop {
        let msg = match event::read() {
            Ok(Event::Key(k)) => match translate_key(k) {
                Some(k) => Input::Key(k),
                None => continue,
            },
            Ok(Event::Resize(..)) => Input::Resize,
            Ok(_) => continue,
            Err(_) => return,
        };
        if in_tx.send(msg).is_err() {
            return;
        }
    });

    let mut app = App::new(profile);
    terminal.draw(|f| ui::draw(f, &app))?;
    while !app.quit {
        tokio::select! {
            input = in_rx.recv() => match input {
                None => break,
                Some(Input::Resize) => terminal.autoresize()?,
                Some(Input::Key(k)) => {
                    for effect in app.handle_key(k) {
                        match effect {
                            Effect::Redraw => terminal.clear()?,
                            Effect::Bus(req) => {
                                let _ = req_tx.send(req);
                            }
                        }
                    }
                }
            },
            ev = ev_rx.recv() => match ev {
                Some(ev) => app.apply(ev),
                None => break,
            },
        }
        terminal.draw(|f| ui::draw(f, &app))?;
    }

    drop(req_tx);
    let _ = bus_task.await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn translates_ctrl_and_plain_keys() {
        let k = |code, mods| KeyEvent::new(code, mods);
        assert_eq!(
            translate_key(k(KeyCode::Char('C'), KeyModifiers::CONTROL)),
            Some(Key::Ctrl('c'))
        );
        assert_eq!(
            translate_key(k(KeyCode::Up, KeyModifiers::CONTROL)),
            Some(Key::CtrlUp)
        );
        assert_eq!(
            translate_key(k(KeyCode::Char('q'), KeyModifiers::NONE)),
            Some(Key::Char('q'))
        );
        assert_eq!(translate_key(k(KeyCode::F(1), KeyModifiers::NONE)), None);
    }
}
